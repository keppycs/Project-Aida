/** Local, fail-closed secret scanning. Installs nothing and never prints scanner payloads. */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GITLEAKS_VERSION = "8.30.1";
export class SecretScanError extends Error {}

export function privatePath(path) {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/");
  const name = parts.at(-1);
  if (parts.some(part => [".agent-trash", ".cursor", ".wrangler", ".aws", ".ssh", "logs"].includes(part))) return true;
  if (parts.some((part, index) => part === "web" && ["local", "youtube reference"].includes(parts[index + 1]))) return true;
  if (parts[0] === "transcodes" && name !== ".gitkeep") return true;
  return /^\.env/.test(name) || /^\.dev\.vars/.test(name) || name === "config_local.py" ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name) || /^id_(?:rsa|ecdsa|ed25519)(?:[._-].*)?$/.test(name) ||
    /^(?:credentials?|secrets?)(?:[._-].*)?$/.test(name) || /^private[-_]key/.test(name) ||
    /^service[-_]account.*\.json$/.test(name) || /\.(?:mp4|fmp4|mkv|mov|mpd|m3u8|m4s)$/.test(name) || name === ".gitleaksignore";
}

function call(runner, executable, args, root, env) {
  try {
    return runner(executable, args, { cwd: root, env, encoding: "utf8", shell: false, windowsHide: true,
      timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
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

export function main(args = process.argv.slice(2), { root = ROOT, env = process.env, runner = spawnSync,
  output = line => console.log(line) } = {}) {
  if (args.length !== 1 || !["--history", "--staged"].includes(args[0])) {
    throw new SecretScanError("Usage: node scripts/scan-secrets.mjs --history|--staged");
  }
  root = resolve(root);
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
  const names = git(runner, staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] : ["ls-files", "-z"], root, env).split("\0").filter(Boolean);
  const blocked = names.filter(privatePath);
  if (blocked.length) throw new SecretScanError(`Refusing ${staged ? "staged" : "tracked"} private paths: ${blocked.slice(0, 10).map(name => JSON.stringify(name)).join(", ")}${blocked.length > 10 ? ` (${blocked.length} total)` : ""}. ${staged ? "Unstage them before committing." : "Remove them from the tracked tree before publishing."}`);

  const executable = env.AIDA_GITLEAKS_PATH?.trim() || git(runner, ["config", "--local", "--get", "aida.gitleaksPath"], root, env, true).trim();
  if (!executable) throw new SecretScanError(`Gitleaks ${GITLEAKS_VERSION} is required. Set AIDA_GITLEAKS_PATH or local aida.gitleaksPath; no download was attempted.`);
  const version = call(runner, executable, ["version"], root, env);
  if (version.error || version.signal || version.status !== 0 || String(version.stdout ?? "").trim() !== GITLEAKS_VERSION) {
    throw new SecretScanError(`Secret scanning requires Gitleaks ${GITLEAKS_VERSION}. No scan was accepted.`);
  }
  const flags = ["git", "--config", configPath, "--redact=100", "--ignore-gitleaks-allow", "--no-banner", "--no-color"];
  if (staged) flags.push("--pre-commit", "--staged");
  else flags.push("--log-opts=--all --reflog --full-history");
  flags.push(root);
  const scan = call(runner, executable, flags, root, env);
  if (scan.error || scan.signal || scan.status !== 0) {
    if (!scan.error && !scan.signal && scan.status === 1) throw new SecretScanError("Secret scan blocked: potential secrets detected. Scanner payloads were withheld; inspect with a redacted local report.");
    throw new SecretScanError("Secret scanning did not complete. No result was accepted; subprocess diagnostics were withheld.");
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
