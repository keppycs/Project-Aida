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
  scanError, scanSignal, gitStatus = 0, historical = [], tip = "a".repeat(40), commitStatus = 0, input = "",
  shallow = false, metadata = "Synthetic commit metadata", tagBodies = {}, metadataScanStatus = scanStatus } = {}) {
  const calls = [], output = [];
  const runner = (file, args, options) => {
    calls.push({ file, args, options });
    if (file === "git") {
      const command = args[2];
      if (gitStatus) return { status: gitStatus, stderr: "Synthetic subprocess payload" };
      if (command === "rev-parse") {
        if (args.includes("--show-toplevel")) return { status: 0, stdout: root + "\n" };
        if (args.includes("--is-shallow-repository")) return { status: 0, stdout: String(shallow) + "\n" };
        return { status: commitStatus, stdout: tip + "\n", stderr: "Synthetic subprocess payload" };
      }
      if (command === "diff") return { status: 0, stdout: staged.join("\0") + (staged.length ? "\0" : "") };
      if (command === "ls-files") return { status: 0, stdout: tracked.join("\0") + (tracked.length ? "\0" : "") };
      if (command === "log") return { status: 0, stdout: args.includes("--format=raw") ? metadata : historical.join("\0") + (historical.length ? "\0" : "") };
      if (command === "cat-file") return { status: 0, stdout: args[3] === "-t" ? (tagBodies[args[4]] ? "tag\n" : "commit\n") : tagBodies[args[4]] };
      if (command === "config") return { status: tool ? 0 : 1, stdout: tool };
      assert.fail(`Unexpected Git command: ${command}`);
    }
    assert.equal(file, tool);
    if (args[0] === "version") return { status: 0, stdout: version + "\n" };
    return { status: args[0] === "stdin" ? metadataScanStatus : scanStatus, error: scanError, signal: scanSignal, stdout: "Synthetic subprocess payload", stderr: "Synthetic subprocess payload" };
  };
  return { calls, output, options: { root, runner, env: {}, output: line => output.push(line), stdin: () => input } };
}

test("history scans all refs and reflogs with enforced redaction and repository config", async t => {
  const root = await fixture(t), run = harness(root);
  assert.equal(main(["--history"], run.options), 0);
  const scan = run.calls.find(call => call.args[0] === "git");
  assert.deepEqual(scan.args, ["git", "--config", join(root, ".gitleaks.toml"), "--redact=100", "--ignore-gitleaks-allow", "--no-banner", "--no-color", "--log-opts=--full-history --root -m --all --reflog", root]);
  assert.ok(run.calls.find(call => call.args[2] === "log").args.includes("--reflog"));
  assert.equal(scan.options.shell, false);
  assert.equal(scan.options.cwd, root);
  assert.equal(scan.options.env.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(scan.options.env.GIT_GRAFT_FILE, join(root, ".git", "aida-disabled-grafts"));
  assert.equal(run.output.length, 1);
  assert.equal(run.output[0].includes("Synthetic subprocess payload"), false);
});

test("staged scan uses the index and rejects forced-added private files before scanner execution", async t => {
  const root = await fixture(t);
  const blocked = [".env", ".env.local", ".envrc", "edge/.dev.vars.production", "src/config_local.py", ".agent-trash/snapshot/file.mjs", "logs/deploy/config.toml", "web/local/video/segment.m4s", "web/youtube reference/saved.html", ".cursor/rules/private.mdc", ".vscode/settings.json", "debug.log", ".wrangler/state.sqlite", "certificate.pfx", "private.pem", "private_key.txt", "id_ed25519", "credentials.toml", "service-account.json", "transcodes/output.txt", "video.mp4", "docs/DESIGN_LANGUAGE.md", "docs/UI_DESIGN.md", "docs/BEHAVIOR.md", ".gitleaksignore"];
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
  assert.equal(privatePath("docs/AIDA_DESIGN.md"), false);
  assert.equal(privatePath("tests/publication-guard.integration.test.mjs"), false);
  assert.equal(privatePath("DOCS\\UI_DESIGN.md"), true);
  assert.equal(privatePath(".VSCODE/settings.json"), true);
  assert.equal(privatePath("deploy.LOG"), true);
  assert.equal(privatePath("transcodes/.gitkeep"), false);
});

test("publication scans only the complete HEAD ancestry and rejects deleted historical private paths", async t => {
  const root = await fixture(t), run = harness(root, { tracked: ["readme.md"] });
  assert.equal(main(["--published"], run.options), 0);
  const history = run.calls.find(call => call.args[2] === "log");
  assert.deepEqual(history.args.slice(2), ["log", "--format=", "--name-only", "-z", "--full-history", "--root", "-m", "--no-renames", "--diff-filter=ACM", "a".repeat(40)]);
  assert.ok(run.calls.find(call => call.args[0] === "git").args.includes(`--log-opts=--full-history --root -m ${"a".repeat(40)}`));
  for (const mode of ["--published", "--history"]) {
    const blocked = harness(root, { historical: ["src/config_local.py", "docs/UI_DESIGN.md"] });
    assert.throws(() => main([mode], blocked.options), /Refusing historical private paths/);
    assert.ok(blocked.calls.every(call => call.file === "git"));
  }
});

test("pre-push scans outgoing commit ancestry independently of local index and recovery refs", async t => {
  const root = await fixture(t), oid = "b".repeat(40);
  const run = harness(root, { staged: [".env"], tracked: [".env"], tip: oid,
    input: `refs/heads/main ${oid} refs/heads/main ${"0".repeat(40)}\n` });
  assert.equal(main(["--pre-push"], run.options), 0);
  assert.ok(run.calls.every(call => !["ls-files", "diff"].includes(call.args[2])));
  const history = run.calls.find(call => call.args[2] === "log");
  assert.equal(history.args.at(-1), oid);
  assert.ok(history.args.every(arg => !["--all", "--reflog"].includes(arg)));
  assert.ok(run.calls.find(call => call.args[0] === "git").args.includes(`--log-opts=--full-history --root -m ${oid}`));
});

test("pre-push rejects malformed metadata, internal refs and noncommit objects without diagnostics", async t => {
  const root = await fixture(t), oid = "b".repeat(40), zeros = "0".repeat(40);
  for (const input of ["incomplete\n", `refs/heads/main --all refs/heads/main ${zeros}\n`,
    `refs/heads/main ${oid} refs/codex/checkpoint ${zeros}\n`,
    `refs/codex/checkpoint ${oid} refs/heads/recovery ${zeros}\n`]) {
    const run = harness(root, { input });
    assert.throws(() => main(["--pre-push"], run.options), SecretScanError);
    assert.ok(run.calls.every(call => call.file === "git"));
  }
  const run = harness(root, { input: `refs/tags/tree ${oid} refs/tags/tree ${zeros}\n`, commitStatus: 128 });
  assert.throws(() => main(["--pre-push"], run.options), error => error instanceof SecretScanError && /commit-based/.test(error.message) && !error.message.includes("Synthetic subprocess payload"));
  assert.throws(() => main(["--pre-push"], { ...harness(root).options, stdin: () => { throw new Error("Synthetic subprocess payload"); } }), /Could not read pre-push ref metadata/);
});

test("pre-push no-op and deletion-only updates do not require a scanner", async t => {
  const root = await fixture(t);
  for (const input of ["", `\n`, `(delete) ${"0".repeat(40)} refs/heads/old ${"b".repeat(40)}\n`,
    `(delete) ${"0".repeat(40)} refs/codex/old ${"b".repeat(40)}\n`]) {
    const run = harness(root, { input, tool: "" });
    assert.equal(main(["--pre-push"], run.options), 0);
    assert.deepEqual(run.calls.map(call => call.args[2]), ["rev-parse"]);
  }
});

test("publication requires complete history and prevents local ancestry overrides", async t => {
  const root = await fixture(t);
  const incomplete = harness(root, { shallow: true });
  assert.throws(() => main(["--published"], incomplete.options), /Complete Git history/);
  assert.ok(incomplete.calls.every(call => call.file === "git"));
  const run = harness(root);
  main(["--published"], { ...run.options, env: { GIT_NO_REPLACE_OBJECTS: "0", GIT_GRAFT_FILE: "untrusted", GIT_SHALLOW_FILE: "untrusted" } });
  assert.ok(run.calls.every(call => call.options.env.GIT_NO_REPLACE_OBJECTS === "1" && call.options.env.GIT_GRAFT_FILE === join(root, ".git", "aida-disabled-grafts") && !("GIT_SHALLOW_FILE" in call.options.env)));
});

test("publication scans commit and nested annotated-tag metadata with withheld diagnostics", async t => {
  const root = await fixture(t), first = "b".repeat(40), nested = "c".repeat(40), tip = "d".repeat(40);
  const tagBodies = { [first]: `object ${nested}\ntype tag\ntag synthetic\n\nFirst tag message\n`,
    [nested]: `object ${tip}\ntype commit\ntag nested\n\nNested tag message\n` };
  const run = harness(root, { tip, tagBodies, input: `refs/tags/synthetic ${first} refs/tags/synthetic ${"0".repeat(40)}\n` });
  main(["--pre-push"], run.options);
  const scan = run.calls.find(call => call.args[0] === "stdin");
  assert.ok(scan.options.input.includes("Synthetic commit metadata"));
  assert.ok(scan.options.input.includes("First tag message"));
  assert.ok(scan.options.input.includes("Nested tag message"));
  assert.ok(scan.args.includes("--redact=100"));
  const detected = harness(root, { metadataScanStatus: 1 });
  assert.throws(() => main(["--published"], detected.options), error => /potential secrets/.test(error.message) && !error.message.includes("Synthetic subprocess payload"));
  assert.deepEqual(detected.output, []);
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
