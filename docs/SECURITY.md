# Keeping Aida credentials private

Credentials belong in local configuration or server-side secret storage. Public website files, repository files, commit messages, tag annotations and public deployment artifacts must never contain credential values. Worker names, bucket names and public CDN hostnames are identifiers; knowing them must not grant access.

Write documentation about Aida's own behavior and requirements. Do not import descriptions or specifications from other private projects. Review prose for private information before committing or publishing it; generic credential detectors cannot reliably identify private project descriptions.

## Local files and logs

- Keep `.env*`, `.dev.vars*`, `config_local.py`, private keys, deployment state, personal editor settings, logs, local media and saved reference pages out of Git. Ignore rules protect local files, and the commit and publication guards reject private paths even when added with `git add -f`. Personal editor folders such as `.cursor/` and `.vscode/`, loose `*.log` files and retired design-document paths are also blocked.
- `.agent-trash/` is recoverable local storage and may contain credentials or private data. It must stay ignored and must never enter a website artifact, repository archive or support upload. Moving a file there preserves its contents; it does not erase a secret.
- Never put credentials in logs, screenshots or reports. Log binding names, outcomes and redacted errors. Do not log request authorization headers, tokens, secret binding values or credential-bearing configuration objects.
- Treat local credential backups as sensitive. Restore a redacted deployment configuration only when needed, and do not use a public report or screenshot to transfer it.
- Before replacing an untracked configuration or cleaning a log, preserve the original using the repository's local-trash policy. Permanent removal requires explicit approval.

## Scan before committing

Aida uses [Gitleaks](https://github.com/gitleaks/gitleaks), pinned to version **8.30.1**. Obtain the official binary and verify its release checksum. Keep the binary in an ignored project-local tool directory. The scanner runs locally; no repository content is uploaded for analysis.

Set `AIDA_GITLEAKS_PATH` to the scanner executable, or configure this clone with:

```sh
git config --local aida.gitleaksPath PATH_TO_GITLEAKS
git config --local core.hooksPath .githooks
```

This activates both `.githooks/pre-commit` and `.githooks/pre-push`. The hooks invoke Node from `aida.nodePath` when configured, otherwise from `PATH`. Configure `aida.nodePath` if Node is not available in the Git environment. On systems that require executable hook files, make both hooks executable when installing them.

Stage only explicit intended paths with `git add -- path/to/file`, review the full `git diff --cached` and run the staged guard before committing. Check that the staged diff includes only the intended changes and no private content. Review commit messages and tag annotations manually too. The pre-commit hook cannot inspect a future commit message; the pre-push guard scans messages and annotations before transmission.

```sh
node scripts/scan-secrets.mjs --staged
node scripts/scan-secrets.mjs --history
node scripts/scan-secrets.mjs --published
git hook run pre-commit
```

The staged check scans the Git index and blocks private filenames. The published check scans all commits reachable from `HEAD`, including their historical paths and raw commit metadata such as messages. The history check is a broader forensic audit of all available local refs and reflogs. It can report retained recovery material that remains local, even when the selected publication ancestry passes. Use the outgoing and published checks to assess the ancestry being published.

Ancestry scans inspect the original stored history with local replacement and graft views disabled. They reject shallow history so missing ancestors cannot produce a passing result.

A missing scanner, wrong version, detection, invalid metadata or incomplete scan blocks the operation. Scanner subprocess output is withheld to keep accidental values out of terminal logs.

`.gitleaks.toml` extends the default detectors and adds Aida's credential field names. Its exceptions cover exact environment-variable statements and exact synthetic test values. Do not add broad path exclusions, historical finding baselines or inline suppressions to pass a scan. Review a suspected false positive before making a narrow exception.

For investigation, use a fully redacted report in an ignored local directory. A successful scan is evidence from the available files and history; it cannot prove that a credential was never copied elsewhere or that an account has no active compromised keys.

When changing these guards, run the tests below with `AIDA_GITLEAKS_PATH` set to the verified scanner executable. The integration tests use real Gitleaks and generated local repository fixtures.

```sh
node --test tests/scan-secrets.test.mjs tests/publication-guard.integration.test.mjs tests/stage-public-site.test.mjs
```

## Before an authorized push

Pushes and publication require the user's explicit request. Before an authorized push, verify that this clone uses `.githooks` and let the pre-push hook run. It passes Git's ref-update input to `--pre-push`, which checks the full reachable history of each outgoing commit tip, including files removed in later commits and raw commit metadata such as messages. For annotated tags, it also scans every tag annotation in a nested tag chain before transmission. It excludes unrelated retained local refs and reflogs, rejects refs that do not resolve to commits and checkpoint refs under `refs/codex/`, and fails on malformed or incomplete metadata.

Never bypass a guard with `--no-verify`, hook or configuration overrides, finding baselines or suppressions. Resolve the finding before retrying. Keep recovery refs local; never use `--mirror` or `--all` pushes to publish them. An existing remote copy or a deletion in a later commit does not make sensitive ancestry safe to send again.

## Publication boundaries

- The secret-scan workflow uses `--published` to check the complete fetched ancestry of `HEAD` on pushes and pull requests. Pages deployment depends on that check succeeding.
- `scripts/stage-public-site.mjs` stages only the explicitly reviewed public file list. It rejects unexpected files, links, missing assets and existing output destinations. Local media and saved reference trees are excluded without opening their contents.
- Adding a public website asset requires updating that list and reviewing the new file for private data. The output preserves the website's public URL layout.
- Ignored files remain sensitive local data. Never upload a raw repository-directory archive, logs or recovery trash. For an authorized Git archive, include only explicitly reviewed and approved tracked files; do not assume every tracked file is suitable for publication.
- Owner-editor packaging uses its separate approved asset list in `scripts/build-admin-assets.mjs`; it must never include local credential configuration.
- Hooks are installed per clone, and CI runs after a push reaches the remote. Enable host-side secret scanning and push protection where available, and require the secret check before merging. Verify those repository settings separately; a local scan does not configure them.

## If a credential is exposed

Revoke or rotate it at its provider first, update the consumers and verify access. Removing the current file does not invalidate a key or remove older commits, forks, clones, downloads or deployment artifacts. Do not rewrite history or force-push without explicit approval. Keep incident notes redacted and distinguish confirmed exposure from scanner false positives.
