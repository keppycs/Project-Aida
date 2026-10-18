/** Local, fail-closed secret scanning. Installs nothing and never prints scanner payloads. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GITLEAKS_VERSION = "8.30.1";
export class SecretScanError extends Error {}
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const retiredDocuments = new Set(["docs/design_language.md", "docs/ui_design.md", "docs/behavior.md"]);

export function privatePath(path) {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/");
  const name = parts.at(-1);
  if (retiredDocuments.has(parts.join("/"))) return true;
  if (parts.some(part => [".agent-trash", ".cursor", ".vscode", ".wrangler", ".aws", ".ssh", "logs"].includes(part))) return true;
  if (parts.some((part, index) => part === "web" && ["local", "youtube reference"].includes(parts[index + 1]))) return true;
  if (parts[0] === "transcodes" && name !== ".gitkeep") return true;
  return /^\.env/.test(name) || /^\.dev\.vars/.test(name) || name === "config_local.py" ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name) || /^id_(?:rsa|ecdsa|ed25519)(?:[._-].*)?$/.test(name) ||
    /^(?:credentials?|secrets?)(?:[._-].*)?$/.test(name) || /^private[-_]key/.test(name) ||
    /^service[-_]account.*\.json$/.test(name) || /\.(?:log|mp4|fmp4|mkv|mov|mpd|m3u8|m4s)$/.test(name) || name === ".gitleaksignore";
}

function call(runner, executable, args, root, env, input) {
  try {
    return runner(executable, args, { cwd: root, env, encoding: "utf8", shell: false, windowsHide: true,
      timeout: 300_000, maxBuffer: 16 * 1024 * 1024, input });
  } catch {
    throw new SecretScanError("Secret scanning could not run. Subprocess diagnostics were withheld.");
  }
}

function git(runner, args, root, env, optional = false) {
  const result = call(runner, "git", ["-C", root, ...args], root, env);
  if (result.error || result.signal || (result.status !== 0 && !(optional && result.status === 1))) {
    throw new SecretScanError("Could not inspect local Git state for secret scanning.");
  }
  return result.status === 0 ? String(result.stdout ?? "") : "";
}

function commit(runner, revision, root, env) {
  const result = call(runner, "git", ["-C", root, "rev-parse", "--verify", `${revision}^{commit}`], root, env);
  const oid = String(result.stdout ?? "").trim();
  if (result.error || result.signal || result.status !== 0 || !objectId.test(oid)) {
    throw new SecretScanError("Publication requires available commit-based branches or tags. Git diagnostics were withheld.");
  }
  return oid;
}

function pushTips(input, runner, root, env) {
  const tips = new Set(), objects = new Set();
  for (const line of input.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split(" ");
    if (fields.length !== 4 || !fields[0] || !fields[2] || !objectId.test(fields[1]) || !objectId.test(fields[3])) {
      throw new SecretScanError("Invalid pre-push ref metadata. Nothing was accepted for publication.");
    }
    const [localRef, localOid, remoteRef] = fields;
    if (/^0+$/.test(localOid)) continue; // Removing a remote ref publishes no content.
    if (localRef.startsWith("refs/codex/") || !/^refs\/(?:heads|tags)\/.+/.test(remoteRef)) {
      throw new SecretScanError("Publication refuses internal recovery refs. Only branches and commit-based tags may be pushed.");
    }
    tips.add(commit(runner, localOid, root, env));
    objects.add(localOid);
  }
  return { tips: [...tips], objects: [...objects] };
}

function tagMetadata(objects, runner, root, env) {
  const messages = [], seen = new Set();
  for (let oid of objects) {
    let depth = 0;
    while (!seen.has(oid)) {
      if (++depth > 256) throw new SecretScanError("Annotated tag history is too deep to verify. Publication was not accepted.");
      seen.add(oid);
      const type = git(runner, ["cat-file", "-t", oid], root, env).trim();
      if (type === "commit") break;
      if (type !== "tag") throw new SecretScanError("Publication requires commit-based tags.");
      const body = git(runner, ["cat-file", "-p", oid], root, env);
      const target = /^object ([a-f0-9]{40}|[a-f0-9]{64})\n/i.exec(body)?.[1];
      if (!target) throw new SecretScanError("Invalid annotated tag metadata. Publication was not accepted.");
      messages.push(body);
      oid = target;
    }
  }
  return messages.join("\n");
}

function acceptScan(scan) {
  if (scan.error || scan.signal || scan.status !== 0) {
    if (!scan.error && !scan.signal && scan.status === 1) throw new SecretScanError("Secret scan blocked: potential secrets detected. Scanner payloads were withheld; inspect with a redacted local report.");
    throw new SecretScanError("Secret scanning did not complete. No result was accepted; subprocess diagnostics were withheld.");
  }
}

function checkPaths(names, label) {
  const blocked = [...new Set(names.filter(privatePath))];
  if (blocked.length) throw new SecretScanError(`Refusing ${label} private paths: ${blocked.slice(0, 10).map(name => JSON.stringify(name)).join(", ")}${blocked.length > 10 ? ` (${blocked.length} total)` : ""}. Review the affected files and history before publishing.`);
}

export function main(args = process.argv.slice(2), { root = ROOT, env = process.env, runner = spawnSync,
  output = line => console.log(line), stdin = () => readFileSync(0, "utf8") } = {}) {
  if (args.length !== 1 || !["--history", "--staged", "--published", "--pre-push"].includes(args[0])) {
    throw new SecretScanError("Usage: node scripts/scan-secrets.mjs --staged|--published|--pre-push|--history");
  }
  root = resolve(root);
  // Scan original stored ancestry even when a local recovery view uses replacements or grafts.
  const noGrafts = resolve(root, ".git", "aida-disabled-grafts");
  if (existsSync(noGrafts)) throw new SecretScanError("Cannot disable local ancestry overrides. No scan was accepted.");
  env = { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: noGrafts };
  delete env.GIT_SHALLOW_FILE;
  const actualRoot = git(runner, ["rev-parse", "--show-toplevel"], root, env).trim();
  if (resolve(actualRoot) !== root) throw new SecretScanError("Secret scanning must use this repository's root.");

  const configPath = resolve(root, ".gitleaks.toml");
  if (!existsSync(configPath) || !lstatSync(configPath).isFile() || lstatSync(configPath).isSymbolicLink()) {
    throw new SecretScanError("The repository's regular .gitleaks.toml is required.");
  }
  if (existsSync(resolve(root, ".gitleaksignore"))) {
    throw new SecretScanError("Secret scanning refuses .gitleaksignore suppressions.");
  }
  const staged = args[0] === "--staged";
  const pushing = args[0] === "--pre-push";
  const forensic = args[0] === "--history";
  let tips = [], objects = [];
  if (pushing) {
    let input;
    try { input = stdin(); } catch { throw new SecretScanError("Could not read pre-push ref metadata. Publication was not accepted."); }
    if (typeof input !== "string") throw new SecretScanError("Invalid pre-push ref metadata.");
    ({ tips, objects } = pushTips(input, runner, root, env));
    if (!tips.length) {
      output("No commit history to publish; no secret scan required.");
      return 0;
    }
  } else {
    const names = git(runner, staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "-z"], root, env).split("\0").filter(Boolean);
    checkPaths(names, staged ? "staged" : "tracked");
    if (!staged && !forensic) tips = [commit(runner, "HEAD", root, env)];
  }
  const revisions = forensic ? ["--all", "--reflog"] : tips;
  if (!staged) {
    if (git(runner, ["rev-parse", "--is-shallow-repository"], root, env).trim() !== "false") {
      throw new SecretScanError("Complete Git history is required for publication scanning; shallow history was not accepted.");
    }
    const historical = git(runner, ["log", "--format=", "--name-only", "-z", "--full-history", "--root", "-m", "--no-renames", "--diff-filter=ACM", ...revisions], root, env).split("\0").filter(Boolean);
    checkPaths(historical, "historical");
  }

  const executable = env.AIDA_GITLEAKS_PATH?.trim() || git(runner, ["config", "--local", "--get", "aida.gitleaksPath"], root, env, true).trim();
  if (!executable) throw new SecretScanError(`Gitleaks ${GITLEAKS_VERSION} is required. Set AIDA_GITLEAKS_PATH or local aida.gitleaksPath; no download was attempted.`);
  const version = call(runner, executable, ["version"], root, env);
  if (version.error || version.signal || version.status !== 0 || String(version.stdout ?? "").trim() !== GITLEAKS_VERSION) {
    throw new SecretScanError(`Secret scanning requires Gitleaks ${GITLEAKS_VERSION}. No scan was accepted.`);
  }
  const scanOptions = ["--config", configPath, "--redact=100", "--ignore-gitleaks-allow", "--no-banner", "--no-color"];
  const flags = ["git", ...scanOptions];
  if (staged) flags.push("--pre-commit", "--staged");
  else flags.push(`--log-opts=--full-history --root -m ${revisions.join(" ")}`);
  flags.push(root);
  acceptScan(call(runner, executable, flags, root, env));
  if (!staged) {
    const messages = git(runner, ["log", "--format=raw", "--no-patch", "--no-show-signature", "--full-history", ...revisions], root, env);
    const tags = tagMetadata(objects, runner, root, env);
    acceptScan(call(runner, executable, ["stdin", ...scanOptions], root, env, messages + "\n" + tags));
  }
  output(`Secret scan passed (${args[0].slice(2)}, Gitleaks ${GITLEAKS_VERSION}).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) {
    console.error(error instanceof SecretScanError ? error.message : "Secret scanning failed. No result was accepted.");
    process.exitCode = 1;
  }
}
