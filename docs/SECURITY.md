# Keeping Aida credentials private

Credentials belong in local configuration or server-side secret storage. Public website files, repository files, commit messages and public deployment artifacts must never contain credential values. Worker names, bucket names and public CDN hostnames are identifiers; knowing them must not grant access.

## Local files and logs

- Keep `.env*`, `.dev.vars*`, `config_local.py`, private keys, deployment state, personal editor settings, logs, local media and saved reference pages out of Git. `.gitignore` covers these paths; the commit guard also rejects private paths added with `git add -f`.
- `.agent-trash/` is recoverable local storage and may contain credentials or private data. It must stay ignored and must never enter a website artifact, repository archive or support upload. Moving a file there preserves its contents; it does not erase a secret.
- Keep reusable credentials out of routine deployment logs. Log binding names, outcomes and redacted errors. Do not log request authorization headers, tokens, secret binding values or credential-bearing configuration objects.
- Treat local credential backups as sensitive. Restore a redacted deployment configuration only when needed, and do not use a public report or screenshot to transfer it.
- Before replacing an untracked configuration or cleaning a log, preserve the original using the repository's local-trash policy. Permanent removal requires explicit approval.

## Scan before committing

Aida uses [Gitleaks](https://github.com/gitleaks/gitleaks), pinned to version **8.30.1**. Obtain the official binary and verify its release checksum. Keep the binary in an ignored project-local tool directory. The scanner runs locally; no repository content is uploaded for analysis.

Set `AIDA_GITLEAKS_PATH` to the scanner executable, or configure this clone with:

```sh
git config --local aida.gitleaksPath PATH_TO_GITLEAKS
git config --local core.hooksPath .githooks
```

The hook invokes Node from `aida.nodePath` when configured, otherwise from `PATH`. Configure `aida.nodePath` if Node is not available in the Git environment. On systems that require executable hook files, make `.githooks/pre-commit` executable when installing it.

```sh
node scripts/scan-secrets.mjs --staged
node scripts/scan-secrets.mjs --history
git hook run pre-commit
```

The staged check scans the Git index and blocks private filenames. The history check scans all available refs and reflogs and rejects private files in the current index. A missing scanner, wrong version, detection or incomplete scan blocks the operation. Scanner subprocess output is withheld to keep accidental values out of terminal logs.

`.gitleaks.toml` extends the default detectors and adds Aida's credential field names. Its exceptions cover exact environment-variable statements and exact synthetic test values. Do not add broad path exclusions, historical finding baselines or inline suppressions to pass a scan. Review a suspected false positive before making a narrow exception.

For investigation, use a fully redacted report in an ignored local directory. A successful scan is evidence from the available files and history; it cannot prove that a credential was never copied elsewhere or that an account has no active compromised keys.

## Publication boundaries

- The secret-scan workflow checks complete fetched history on pushes and pull requests. Pages deployment depends on that check succeeding.
- `scripts/stage-public-site.mjs` stages only the explicitly reviewed public file list. It rejects unexpected files, links, missing assets and existing output destinations. Local media and saved reference trees are excluded without opening their contents.
- Adding a public website asset requires updating that list and reviewing the new file for private data. The output preserves the website's public URL layout.
- Owner-editor packaging uses its separate approved asset list in `scripts/build-admin-assets.mjs`; it must never include local credential configuration.
- Hooks are installed per clone, and CI runs after a push reaches the remote. Enable host-side secret scanning and push protection where available, and require the secret check before merging. Verify those repository settings separately; a local scan does not configure them.

## If a credential is exposed

Revoke or rotate it at its provider first, update the consumers and verify access. Removing the current file does not invalidate a key or remove older commits, forks, clones, downloads or deployment artifacts. Do not rewrite history or force-push without explicit approval. Keep incident notes redacted and distinguish confirmed exposure from scanner false positives.
