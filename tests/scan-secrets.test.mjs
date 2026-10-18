import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { GITLEAKS_VERSION, ROOT, SecretScanError, main, privatePath } from "../scripts/scan-secrets.mjs";

async function fixture(t) {
  const base = join(ROOT, "logs", "secret-scan-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(base) + sep));
    await rm(root, { recursive: true, force: true }); // Generated only by this test.
  });
  await writeFile(join(root, ".gitleaks.toml"), "title = 'Synthetic test configuration'\n");
  return root;
}

function harness(root, { staged = [], tracked = [], tool = "synthetic-gitleaks", version = GITLEAKS_VERSION, scanStatus = 0,
  scanError, scanSignal, gitStatus = 0 } = {}) {
  const calls = [], output = [];
  const runner = (file, args, options) => {
    calls.push({ file, args, options });
    if (file === "git") {
      const command = args[2];
      if (gitStatus) return { status: gitStatus, stderr: "Synthetic subprocess payload" };
      if (command === "rev-parse") return { status: 0, stdout: root + "\n" };
      if (command === "diff") return { status: 0, stdout: staged.join("\0") + (staged.length ? "\0" : "") };
      if (command === "ls-files") return { status: 0, stdout: tracked.join("\0") + (tracked.length ? "\0" : "") };
      if (command === "config") return { status: tool ? 0 : 1, stdout: tool };
      assert.fail(`Unexpected Git command: ${command}`);
    }
    assert.equal(file, tool);
    if (args[0] === "version") return { status: 0, stdout: version + "\n" };
    return { status: scanStatus, error: scanError, signal: scanSignal, stdout: "Synthetic subprocess payload", stderr: "Synthetic subprocess payload" };
  };
  return { calls, output, options: { root, runner, env: {}, output: line => output.push(line) } };
}

test("history scans all refs and reflogs with enforced redaction and repository config", async t => {
  const root = await fixture(t), run = harness(root);
  assert.equal(main(["--history"], run.options), 0);
  const scan = run.calls.at(-1);
  assert.deepEqual(scan.args, ["git", "--config", join(root, ".gitleaks.toml"), "--redact=100", "--ignore-gitleaks-allow", "--no-banner", "--no-color", "--log-opts=--all --reflog --full-history", root]);
  assert.equal(scan.options.shell, false);
  assert.equal(scan.options.cwd, root);
  assert.equal(run.output.length, 1);
  assert.equal(run.output[0].includes("Synthetic subprocess payload"), false);
});

test("staged scan uses the index and rejects forced-added private files before scanner execution", async t => {
  const root = await fixture(t);
  const blocked = [".env", ".env.local", ".envrc", "edge/.dev.vars.production", "src/config_local.py", ".agent-trash/snapshot/file.mjs", "logs/deploy/config.toml", "web/local/video/segment.m4s", "web/youtube reference/saved.html", ".cursor/rules/private.mdc", ".wrangler/state.sqlite", "certificate.pfx", "private.pem", "private_key.txt", "id_ed25519", "credentials.toml", "service-account.json", "transcodes/output.txt", "video.mp4", ".gitleaksignore"];
  for (const name of blocked) {
    const run = harness(root, { staged: [name] });
    assert.throws(() => main(["--staged"], run.options), error => error instanceof SecretScanError && error.message.includes("Refusing staged private paths"));
    assert.ok(run.calls.every(call => call.file === "git"));
  }
  const run = harness(root, { staged: ["web/js/watch.js", "edge/wrangler.toml", "tests/admin-auth.test.mjs"] });
  main(["--staged"], run.options);
  assert.deepEqual(run.calls.find(call => call.args[2] === "diff").args.slice(2), ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
  assert.ok(run.calls.at(-1).args.includes("--pre-commit"));
  assert.ok(run.calls.at(-1).args.includes("--staged"));
  assert.equal(run.calls.at(-1).args.some(arg => arg.startsWith("--log-opts")), false);
});

test("history mode blocks committed private filenames in the current tree before scanning", async t => {
  const root = await fixture(t), run = harness(root, { tracked: ["readme.md", "edge/.env.local"] });
  assert.throws(() => main(["--history"], run.options), error => error instanceof SecretScanError && error.message.includes("Refusing tracked private paths") && error.message.includes("edge/.env.local"));
  assert.deepEqual(run.calls.at(-1).args.slice(2), ["ls-files", "-z"]);
  assert.ok(run.calls.every(call => call.file === "git"));
  assert.deepEqual(run.output, []);
});

test("private path guard handles case, Windows separators and control characters without executing filenames", () => {
  assert.equal(privatePath("EDGE\\.ENV.PRODUCTION"), true);
  assert.equal(privatePath(".agent-trash/saved\nsource.mjs"), true);
  assert.equal(privatePath("tests/admin-auth.test.mjs"), false);
  assert.equal(privatePath("src/config.py"), false);
  assert.equal(privatePath("edge/wrangler.admin.toml"), false);
  assert.equal(privatePath(".github/workflows/security.yml"), false);
  assert.equal(privatePath("docs/SECURITY.md"), false);
  assert.equal(privatePath("transcodes/.gitkeep"), false);
});

test("missing or unexpected scanner and invalid arguments fail closed", async t => {
  const root = await fixture(t);
  assert.throws(() => main(["--history"], harness(root, { tool: "" }).options), /is required/);
  assert.throws(() => main(["--history"], harness(root, { version: "0.0.0" }).options), /No scan was accepted/);
  assert.throws(() => main(["--staged"], harness(root, { gitStatus: 2 }).options), /Could not inspect local Git state/);
  assert.throws(() => main(["--history", "--baseline-path", "file"], harness(root).options), /Usage:/);
  assert.throws(() => main([], harness(root).options), /Usage:/);
});

test("scanner detections, failures and signals never print subprocess payloads", async t => {
  const root = await fixture(t);
  for (const options of [{ scanStatus: 1 }, { scanStatus: 2 }, { scanStatus: null, scanError: new Error("Synthetic subprocess payload") }, { scanStatus: null, scanSignal: "SIGTERM" }]) {
    const run = harness(root, options);
    assert.throws(() => main(["--history"], run.options), error => error instanceof SecretScanError && !error.message.includes("Synthetic subprocess payload"));
    assert.deepEqual(run.output, []);
  }
});

test("environment tool selection takes precedence and suppressions are refused", async t => {
  const root = await fixture(t), run = harness(root, { tool: "environment-gitleaks" });
  main(["--history"], { ...run.options, env: { AIDA_GITLEAKS_PATH: "environment-gitleaks" } });
  assert.ok(run.calls.every(call => call.args[2] !== "config"));
  await writeFile(join(root, ".gitleaksignore"), "synthetic-only\n");
  assert.throws(() => main(["--history"], harness(root).options), /refuses .gitleaksignore/);
});
