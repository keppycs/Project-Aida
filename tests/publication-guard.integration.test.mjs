import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "8.30.1";

// Every commit and push below belongs to a newly generated, isolated local fixture.
// No project refs, index, remotes, network services or external Git config are used.
test("installed publication hooks stop private content before a local remote receives it", { timeout: 240_000 }, async t => {
  const base = join(ROOT, "logs", "publication-guard-integration");
  await mkdir(base, { recursive: true });
  const runRoot = await mkdtemp(join(base, "run-"));
  t.after(async () => {
    const owned = relative(base, runRoot);
    assert.ok(owned && !isAbsolute(owned) && !owned.startsWith(`..${sep}`) && owned !== "..");
    await rm(runRoot, { recursive: true, force: true }); // Only this test's generated data.
  });
  const emptyConfig = join(runRoot, "empty-git-config");
  const template = join(runRoot, "empty-template");
  await writeFile(emptyConfig, "");
  await mkdir(template);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]) delete env[name];
  const command = (file, args, cwd) => spawnSync(file, args, { cwd, env, encoding: "utf8",
    shell: false, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const git = (cwd, args) => command("git", ["-c", `core.excludesFile=${emptyConfig}`,
    "-c", `core.attributesFile=${emptyConfig}`, "-C", cwd, ...args], cwd);
  const succeeds = (result, action) => {
    assert.equal(Boolean(result.error || result.signal), false, `${action} must complete`);
    assert.equal(result.status, 0, `${action} must succeed; subprocess payloads withheld`);
    return result;
  };
  const refused = (result, action) => {
    assert.equal(Boolean(result.error || result.signal), false, `${action} must complete`);
    assert.notEqual(result.status, 0, `${action} must be refused`);
    assert.match(result.stdout + result.stderr, /Secret scan|Secret scanning|Refusing|Publication|Complete Git history/i,
      `${action} must fail through the installed guard`);
  };
  const configured = git(ROOT, ["config", "--local", "--get", "aida.gitleaksPath"]);
  const tool = env.AIDA_GITLEAKS_PATH?.trim() || (configured.status === 0 ? configured.stdout.trim() : "");
  if (!tool) {
    t.skip(`Gitleaks ${VERSION} is required for real hook integration; set AIDA_GITLEAKS_PATH or local aida.gitleaksPath.`);
    return;
  }
  const scanner = isAbsolute(tool) || !/[\\/]/.test(tool) ? tool : resolve(ROOT, tool);
  const version = command(scanner, ["version"], ROOT);
  succeeds(version, "Gitleaks version check");
  assert.equal(version.stdout.trim(), VERSION, "Integration must use the pinned scanner version");
  env.AIDA_GITLEAKS_PATH = scanner;

  async function fixture(name) {
    const parent = join(runRoot, name);
    const repo = join(parent, "working");
    const remote = join(parent, "remote.git");
    await mkdir(repo, { recursive: true });
    succeeds(git(repo, ["init", "--initial-branch=main", `--template=${template}`]), "fixture repository initialization");
    succeeds(git(repo, ["init", "--bare", "--initial-branch=fixture-default", `--template=${template}`, remote]), "local bare remote initialization");
    for (const [key, value] of [["user.name", "Aida offline fixture"], ["user.email", "aida-fixture@example.test"],
      ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["core.hooksPath", ".githooks"],
      ["aida.nodePath", process.execPath], ["aida.gitleaksPath", scanner]]) {
      succeeds(git(repo, ["config", "--local", key, value]), "fixture local configuration");
    }
    for (const path of ["scripts/scan-secrets.mjs", ".gitleaks.toml", ".githooks/pre-commit", ".githooks/pre-push"]) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await copyFile(join(ROOT, path), join(repo, path));
      if (path.startsWith(".githooks/")) await chmod(join(repo, path), 0o755);
    }
    await writeFile(join(repo, ".gitignore"), ".vscode/\n*.log\n");
    await writeFile(join(repo, "readme.md"), "Generated offline publication-guard fixture.\n");
    succeeds(git(repo, ["add", "--", ".githooks", ".gitleaks.toml", ".gitignore", "scripts", "readme.md"]), "stage fixture baseline");
    succeeds(git(repo, ["commit", "-m", "Create safe offline fixture"]), "baseline real pre-commit hook");
    succeeds(git(repo, ["remote", "add", "publish", remote]), "configure fixture-only local remote");
    return { repo, remote, git: args => git(repo, args), scan: mode => command(process.execPath, ["scripts/scan-secrets.mjs", mode], repo) };
  }

  const write = async (repo, path, text) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  };
  const credential = () => `${["AIDA", "ACCESS", "CLIENT", "SECRET"].join("_")}=${randomBytes(24).toString("hex")}\n`;
  const assertAbsent = (remote, ref) => {
    assert.equal(git(remote, ["show-ref", "--verify", "--quiet", ref]).status, 1, "Blocked content must not create the destination ref");
  };

  await t.test("real pre-commit refuses forced private paths and never discloses detected values", async () => {
    const f = await fixture("pre-commit");
    for (const path of [".vscode/settings.json", "loose.log", "docs/DESIGN_LANGUAGE.md", "docs/UI_DESIGN.md", "docs/BEHAVIOR.md"]) {
      await write(f.repo, path, "Synthetic private fixture content.\n");
      succeeds(f.git(["add", "-f", "--", path]), "force-stage synthetic private path");
      const result = f.git(["commit", "-m", "This private fixture must not commit"]);
      refused(result, "forced-private-path commit");
      assert.match(result.stderr, /private paths/i);
      succeeds(f.git(["rm", "--cached", "--force", "--", path]), "unstage the rejected fixture path");
    }
    const payload = credential();
    await write(f.repo, "sample.txt", payload);
    succeeds(f.git(["add", "--", "sample.txt"]), "stage generated fake credential");
    const result = f.git(["commit", "-m", "This fake credential must not commit"]);
    refused(result, "synthetic-credential commit");
    assert.equal((result.stdout + result.stderr).includes(payload.trim().split("=")[1]), false,
      "Hook output must withhold the synthetic credential");
    assert.equal(f.git(["rev-list", "--count", "HEAD"]).stdout.trim(), "1", "Refused commits must not advance HEAD");
  });

  await t.test("real pre-push detects a secret committed with verification bypassed and then deleted", async () => {
    const f = await fixture("deleted-credential");
    const payload = credential();
    await write(f.repo, "sample.txt", payload);
    succeeds(f.git(["add", "--", "sample.txt"]), "stage synthetic history fixture");
    succeeds(f.git(["-c", "core.hooksPath=", "commit", "--no-verify", "-m", "Create deliberately unsafe offline history"]), "fixture-only verification bypass");
    succeeds(f.git(["rm", "--", "sample.txt"]), "remove fake credential from fixture tip");
    succeeds(f.git(["commit", "-m", "Remove fake credential from fixture tip"]), "commit clean fixture tip");
    const result = f.git(["push", "publish", "main"]);
    refused(result, "push containing deleted synthetic credential");
    assert.equal((result.stdout + result.stderr).includes(payload.trim().split("=")[1]), false,
      "Pre-push output must withhold the synthetic credential");
    assertAbsent(f.remote, "refs/heads/main");
  });

  await t.test("pre-push blocks private filenames and retired documents even after removal from the tip", async () => {
    for (const [name, paths] of [["deleted-private-path", [".vscode/local.json"]],
      ["deleted-retired-docs", ["docs/DESIGN_LANGUAGE.md", "docs/UI_DESIGN.md", "docs/BEHAVIOR.md"]]]) {
      const f = await fixture(name);
      for (const path of paths) await write(f.repo, path, "Synthetic offline private-history fixture.\n");
      succeeds(f.git(["add", "-f", "--", ...paths]), "stage private history paths");
      succeeds(f.git(["-c", "core.hooksPath=", "commit", "--no-verify", "-m", "Create deliberately private offline history"]), "fixture-only private-path bypass");
      succeeds(f.git(["rm", "--", ...paths]), "remove private fixture paths from tip");
      succeeds(f.git(["commit", "-m", "Remove private fixture paths from tip"]), "commit path-free fixture tip");
      const result = f.git(["push", "publish", "main"]);
      refused(result, "push containing historical private paths");
      for (const path of paths) assert.ok((result.stdout + result.stderr).includes(path), "Guard must identify each blocked historical path");
      assertAbsent(f.remote, "refs/heads/main");
    }
  });

  await t.test("pre-push detects a credential introduced only in a merge commit", async () => {
    const f = await fixture("merge-only-credential");
    succeeds(f.git(["checkout", "-b", "safe-side"]), "create synthetic side branch");
    await write(f.repo, "side.txt", "Synthetic side change.\n");
    succeeds(f.git(["add", "--", "side.txt"]), "stage safe side change");
    succeeds(f.git(["commit", "-m", "Add safe side fixture"]), "commit safe side change");
    succeeds(f.git(["checkout", "main"]), "return to synthetic main");
    await write(f.repo, "main.txt", "Synthetic main change.\n");
    succeeds(f.git(["add", "--", "main.txt"]), "stage safe main change");
    succeeds(f.git(["commit", "-m", "Add safe main fixture"]), "commit safe main change");
    succeeds(f.git(["merge", "--no-commit", "--no-ff", "safe-side"]), "prepare a real two-parent merge");
    await write(f.repo, "merge.txt", credential());
    succeeds(f.git(["add", "--", "merge.txt"]), "stage synthetic merge-only credential");
    succeeds(f.git(["-c", "core.hooksPath=", "commit", "--no-verify", "-m", "Deliberately unsafe offline merge fixture"]), "fixture-only merge bypass");
    assert.equal(f.git(["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(" ").length, 3);
    refused(f.git(["push", "publish", "main"]), "merge-only credential push");
    assertAbsent(f.remote, "refs/heads/main");
  });

  await t.test("pre-push detects credentials in commit messages and annotated tag messages", async () => {
    const f = await fixture("commit-message-credential");
    const payload = credential().trim();
    succeeds(f.git(["-c", "core.hooksPath=", "commit", "--no-verify", "--allow-empty", "-m", "Synthetic message fixture", "-m", payload]), "fixture-only unsafe commit message");
    const messagePush = f.git(["push", "publish", "main"]);
    refused(messagePush, "commit-message-only credential push");
    assert.equal((messagePush.stdout + messagePush.stderr).includes(payload.split("=")[1]), false);
    assertAbsent(f.remote, "refs/heads/main");

    const tagged = await fixture("tag-message-credential");
    const annotation = credential().trim();
    succeeds(tagged.git(["tag", "-a", "offline-secret", "-m", annotation]), "create synthetic unsafe tag annotation");
    const tagPush = tagged.git(["push", "publish", "refs/tags/offline-secret"]);
    refused(tagPush, "tag-message-only credential push");
    assert.equal((tagPush.stdout + tagPush.stderr).includes(annotation.split("=")[1]), false);
    assertAbsent(tagged.remote, "refs/tags/offline-secret");
  });

  await t.test("replacement and graft views cannot hide private ancestry, and shallow history is refused", async () => {
    const f = await fixture("masked-private-history");
    const baseline = succeeds(f.git(["rev-parse", "HEAD"]), "read safe fixture baseline").stdout.trim();
    await write(f.repo, ".vscode/local.json", "Synthetic private fixture.\n");
    succeeds(f.git(["add", "-f", "--", ".vscode/local.json"]), "stage synthetic private ancestor");
    succeeds(f.git(["-c", "core.hooksPath=", "commit", "--no-verify", "-m", "Private offline ancestor"]), "fixture-only private ancestor bypass");
    succeeds(f.git(["rm", "--", ".vscode/local.json"]), "remove private ancestor path from tip");
    succeeds(f.git(["commit", "-m", "Remove offline private path"]), "commit clean fixture tip");
    const head = succeeds(f.git(["rev-parse", "HEAD"]), "read original fixture tip").stdout.trim();
    succeeds(f.git(["replace", "--graft", "HEAD", baseline]), "create masking replacement in fixture");
    refused(f.scan("--published"), "publication scan with masking replacement");
    succeeds(f.git(["replace", "-d", head]), "remove generated fixture replacement");
    await write(f.repo, ".git/info/grafts", `${head} ${baseline}\n`);
    refused(f.scan("--published"), "publication scan with masking legacy graft");

    const shallow = await fixture("shallow-history");
    const shallowHead = succeeds(shallow.git(["rev-parse", "HEAD"]), "read shallow fixture tip").stdout.trim();
    await write(shallow.repo, ".git/shallow", shallowHead + "\n");
    const result = shallow.scan("--published");
    refused(result, "shallow publication scan");
    assert.match(result.stderr, /shallow history/i);
  });

  await t.test("safe main publishes despite private local recovery history; checkpoint and non-commit refs cannot publish", async () => {
    const f = await fixture("safe-outgoing-main");
    succeeds(f.git(["checkout", "-b", "offline-private-recovery"]), "create synthetic local recovery branch");
    await write(f.repo, ".vscode/local.json", credential());
    succeeds(f.git(["add", "-f", "--", ".vscode/local.json"]), "stage local recovery fixture");
    succeeds(f.git(["-c", "core.hooksPath=", "commit", "--no-verify", "-m", "Retain deliberately unsafe offline recovery history"]), "fixture-only recovery bypass");
    succeeds(f.git(["checkout", "main"]), "return to safe outgoing branch");
    succeeds(f.scan("--published"), "published-history scan with unrelated private recovery refs");
    refused(f.scan("--history"), "full local audit containing private recovery history");
    succeeds(f.git(["push", "publish", "main"]), "safe outgoing main pre-push hook");
    succeeds(git(f.remote, ["show-ref", "--verify", "--quiet", "refs/heads/main"]), "safe main arrives at local remote");
    const commit = succeeds(f.git(["rev-parse", "HEAD"]), "read fixture commit").stdout.trim();
    succeeds(f.git(["update-ref", "refs/codex/offline-checkpoint", commit]), "create synthetic internal checkpoint ref");
    refused(f.git(["push", "publish", "refs/codex/offline-checkpoint:refs/heads/unsafe-checkpoint"]), "internal checkpoint ref push");
    assertAbsent(f.remote, "refs/heads/unsafe-checkpoint");
    const tree = succeeds(f.git(["rev-parse", "HEAD^{tree}"]), "read fixture tree").stdout.trim();
    succeeds(f.git(["update-ref", "refs/tags/offline-tree", tree]), "create non-commit fixture ref");
    refused(f.git(["push", "publish", "refs/tags/offline-tree"]), "non-commit ref push");
    assertAbsent(f.remote, "refs/tags/offline-tree");
    succeeds(f.git(["push", "publish", ":refs/heads/main"]), "safe remote-branch deletion pre-push hook");
    assertAbsent(f.remote, "refs/heads/main");
  });
});
