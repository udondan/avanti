# Avanti!

A stateful package manager for arbitrary text files. Declare what you need and
where to get it; avanti fetches, diffs, and writes with full version history,
atomic rollbacks, and diff-before-apply safety.

![Avanti!](https://raw.githubusercontent.com/udondan/avanti/assets/avanti.png 'Avanti!')

## Table of Contents

- [Intro](#intro)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
  - [`avanti diff`](#avanti-diff)
  - [`avanti pull`](#avanti-pull)
  - [`avanti lock`](#avanti-lock)
  - [`--verbose` / `-v`](#--verbose---v)
- [History](#history)
  - [`avanti log`](#avanti-log)
  - [`avanti diff <pullId>`](#avanti-diff-pullid)
  - [`avanti revert [pullId]`](#avanti-revert-pullid)
  - [`avanti reset`](#avanti-reset)
- [Working Directory](#working-directory)
  - [Path Constraints](#path-constraints)
- [Configuration](#configuration)
  - [File Entry Fields](#file-entry-fields)
  - [Source Types](#source-types)
    - [SHA pinning](#sha-pinning)
    - [Filter](#filter)
    - [Extract](#extract)
  - [Directory Sources](#directory-sources)
  - [JSON Merging](#json-merging)
  - [YAML Merging](#yaml-merging)
  - [TOML Merging](#toml-merging)
  - [INI Merging](#ini-merging)
  - [Template Rendering](#template-rendering)
  - [Event Hooks](#event-hooks)
  - [Insert Mode](#insert-mode)
  - [Conditions](#conditions)
    - [Condition fields](#condition-fields)
    - [Examples](#examples)
  - [Scaffold Pattern](#scaffold-pattern)
  - [Backup](#backup)
    - [Path variables](#path-variables)
    - [Counter pattern](#counter-pattern)
    - [Security: backup_roots](#security-backup_roots)
    - [Backup examples](#backup-examples)
  - [Write in Place](#write-in-place)
  - [Follow Symlink](#follow-symlink)
  - [Sudo](#sudo)
  - [Variables](#variables)
    - [List and object variables](#list-and-object-variables)
    - [Accessing nested values with \${expr}](#accessing-nested-values-with-expr)
    - [Source-based variables](#source-based-variables)
    - [System-injected variables](#system-injected-variables)
  - [$self — Self-managing Config](#self--self-managing-config)
  - [Authentication](#authentication)
  - [Private Instances](#private-instances)
- [Use Cases](#use-cases)
  - [Composable AI Agent Instructions (CLAUDE.md / AGENTS.md)](#composable-ai-agent-instructions-claudemd--agentsmd)
  - [Shared Tooling Config (Renovate, ESLint, Prettier, TSConfig)](#shared-tooling-config-renovate-eslint-prettier-tsconfig)
  - [CI/CD: Shared Workflow Fragments](#cicd-shared-workflow-fragments)
  - [CI/CD: Scheduled Sync PR](#cicd-scheduled-sync-pr)
  - [Environment-Specific Config from a Single Spec](#environment-specific-config-from-a-single-spec)
  - [Secrets from Vault or AWS](#secrets-from-vault-or-aws)
  - [Multi-Project Deployment](#multi-project-deployment)
  - [Docker Compose from Upstream Sources](#docker-compose-from-upstream-sources)
  - [Developer Onboarding Bootstrap](#developer-onboarding-bootstrap)
  - [Scaffold Defaults with Local Overrides](#scaffold-defaults-with-local-overrides)
  - [Self-managing Config](#self-managing-config)
- [Exit Codes](#exit-codes)
- [Development](#development)

## Intro

Avanti is a package manager for arbitrary text files. Your .avanti.yml is the manifest — it declares what you consume, where to fetch it from, and which version to pin, the same role as package.json or Cargo.toml. Source repositories are the packages. avanti pull is the install command.

What makes it stateful: every successful pull is recorded in a local history store. You can diff any two states, revert the whole project to a prior pull, or fully undo all avanti changes — the same guarantees as a lockfile, extended to any text file from any source.

**Declare dependencies** — fetch from anywhere, combine sources:

```yaml
files:
  # Single source: pin a config from GitHub
  eslint.config.js:
    src:
      github:
        repo: org/standards
        file: eslint.config.js
        ref: v2.4.1

  # Multi-source: assemble from wherever the content lives
  CLAUDE.md:
    src:
      - gitlab:
          project: org/platform
          file: ai/base-instructions.md
          ref: main
      - raw: |
          IMPORTANT: Always answer in pirate speak!
      - https://public-standards.example.com/shared-guidelines.md
      - exec: printf "## Team\n%s" "$env:TEAM"
      - path: ~/claude-personal.md
        optional: true # silently skipped if absent
```

**Review and apply upgrades** — the same workflow as reading a lockfile diff before committing:

```sh
# Bump standards ref: v2.4.1 → v2.5.0, then:
avanti diff    # see every file that would change
avanti pull    # apply after review
avanti revert  # roll back instantly if something breaks
```

## Features

- Fetch files from **HTTP/HTTPS**, **local paths**, **GitLab** (via `glab`), **GitHub** (via `gh`), **Bitbucket**, **any git remote**, **S3**, **AWS Secrets Manager**, **SSM Parameter Store**, **HashiCorp Vault**, **shell commands**, or **inline raw content**
- **Multi-source entries** — combine multiple sources into a single file by providing `src` as a list
- **JSON merging** — deep-merge multiple JSON/JSONC sources with configurable conflict, array, and object strategies; format output with configurable indentation, trailing commas, key sorting, minification, and comment stripping
- **YAML merging** — deep-merge multiple YAML/YML sources with the same strategies, with full comment preservation
- **TOML merging** — deep-merge multiple TOML sources with configurable conflict, array, and table strategies
- **INI merging** — deep-merge multiple INI/CFG sources with the same strategies, with full comment and key-order preservation
- **Variables** — define reusable values in a `variables:` block and reference them anywhere with `$name`; variables can be plain strings, `$env:NAME` environment variable references, or fetched from any remote/local source (the same source types as `files:`)
- **Post-processing** — apply text replacements (string or regex) and/or pipe content through a shell script
- **Release artifacts** — download release assets attached to a GitHub or GitLab release by tag, `$latest` (newest stable semver tag), `$recent` (most recently created/published tag), or `/pattern/[flags]` (GitLab prefers `package`-type links; falls back to all links)
- **Directory sync** — recursively sync directories from GitLab/GitHub/Bitbucket/git/S3/local sources
- **SHA pinning** — pin any remote source to a content fingerprint with `sha:`; use `avanti lock` to compute and write SHAs automatically; `avanti pull --accept-changes` reviews a mismatch and updates the pin
- **`$self`** — avanti can manage its own config file; declare `$self` in `files:` and the fetched content becomes the active config for the rest of the run, including YAML/JSON merge from multiple sources
- **Diff preview** — see exactly what will change before applying, or compare against any past pull
- **Atomic writes** — all files are staged to a temp dir first; targets are only written if everything succeeds
- **History** — every pull is recorded; inspect what changed, revert the whole project to a past state, or fully undo all avanti changes
- **Conditions** — use `if` and `ifAny` on file entries or individual sources to conditionally skip based on OS, filesystem path existence, shell command exit code, or whether the target file already exists; supports AND/OR logic and negation with `not: true`
- **Optional sources** — mark `path:` and `url:` sources `optional: true` to silently skip them when the file is missing or the URL returns 404; lets a central config reference per-user local overrides without erroring on machines that haven't created them
- **Stale file cleanup** — files dropped from a directory source are automatically deleted or restored to their pre-avanti content

## Requirements

- Node.js 18+

The `glab` and `gh` CLIs are **optional**. Public repositories are accessed directly over HTTPS without any tools installed. The CLIs are only used as a fallback for private repositories or private instances when no token is configured.

## Install

```sh
npm install -g @udondan/avanti
```

Or run directly:

```sh
npx @udondan/avanti --help
```

## Usage

```text
avanti [options] [command]

Options:
  -c, --config <path|url>          path or remote spec for config file (default: auto-detected)
  -w, --working-dir <path>         working directory for resolving paths (default: current directory)
  -v, --verbose                    print verbose debug output to stderr

Commands:
  diff [pullId]                    Show diff between remote sources and local files, or vs a past pull
  pull [--yes] [--accept-changes]  Pull remote sources and write to local files
  lock [--force]                   Pin SHA values for all remote sources in the config
  log [file]                       Show pull history for the current project
  revert [pullId] [--yes]          Atomically revert all project files to a past pull state
  reset [--yes]                    Restore all tracked files to their pre-avanti state
```

### `avanti diff`

Shows a colored git-diff-like output of what would change. Exits `0` if no changes, `1` if changes detected.

### `avanti pull`

Fetches all sources, shows the diff, and prompts for confirmation before writing. Use `--yes` to skip the prompt.

If any source has a `sha` field and the fetched content's SHA no longer matches, the pull is aborted with a mismatch error. Use `--accept-changes` to review the diff, confirm, and automatically update the SHA values in the config file.

When avanti has previously synced a directory from a remote source and a file is no longer present in that source, the file is treated as stale: if avanti created it, it is deleted; if it existed before avanti first touched it, the original content is restored. Stale file changes appear in the diff before you confirm.

### `avanti lock`

Fetches all remote sources and writes a SHA-256 fingerprint for each one into the config file. Comments and formatting are preserved.

```sh
avanti lock           # pin all unpinned remote sources
avanti lock --force   # overwrite existing SHA values with fresh ones
```

Once a source is pinned, `avanti pull` will verify the fetched content's SHA before applying any changes. If the upstream changed unexpectedly, avanti aborts with a clear error pointing to the affected source:

```text
SHA mismatch for github:org/standards:company-rules.md
  expected: abc123...
  got:      def456...

Run `avanti pull --accept-changes` to review the diff and update SHA values.
```

`avanti diff` shows a `⚠ SHA mismatch` warning inline for any source that no longer matches its pinned SHA.

SHA is computed over the raw fetched content of each source, before any `replace` or `on.write` processing. Each file's path and content are fed into the hash in sorted order, separated by null bytes — so renames and additions affect the fingerprint even for single-file sources. Pull history records the observed SHA for every source, so `avanti log` shows a full audit trail of what changed and when.

Excluded from SHA pinning: local paths and `raw:` sources (their content is either authored locally or inline in the config, so changes are always visible).

### `--verbose` / `-v`

Pass `--verbose` (or `-v`) to any command to print internal debug details to stderr. Verbose output does not appear on stdout, so piping diff output is unaffected.

```sh
avanti diff --verbose
avanti pull -v
```

Each line is prefixed with `[verbose]` and includes:

- The source being fetched (e.g. `github:org/repo:file@main`)
- Every HTTP request URL and response status code
- Retry delays and reasons
- CLI tool invocations (`gh`, `glab`, `vault`, `git`)
- AWS SDK API calls (`s3 GetObject`, `ssm GetParameter`, `secrets-manager GetSecretValue`)
- Cache hits

**Credential safety:** tokens are read from environment variables and sent as HTTP headers, which are never logged. Git URLs with embedded credentials are redacted. `exec:` source commands are logged verbatim — if your config embeds secrets in an exec command (e.g. `exec: curl -H "Token: $env:MY_SECRET"`), those secrets will appear in verbose output after variable substitution.

## History

Every successful `avanti pull` that writes at least one file is recorded in a local history store. This lets you inspect what changed, preview past states, revert the whole project, or fully undo all avanti changes.

History is stored under `~/.config/avanti/` by default. Set `AVANTI_HISTORY_DIR` to override — useful for CI or when you want to keep history inside a repository:

```sh
AVANTI_HISTORY_DIR=.avanti-history avanti pull
```

History is scoped by the **combination of config file path and working directory**, so different projects and different configs are always isolated from each other. If the history directory is missing or corrupt, all commands warn and continue — no crash, no data loss.

### `avanti log`

List all pull runs for the current project, newest first:

```text
pull a1b2c3d4  2026-05-08 14:32:11  .avanti.yml
  /project/config.yml         → v3  (modified)
  /project/scripts/deploy.sh  → v1  (new file)

pull 7f8e9a0b  2026-05-07 09:15:44  .avanti.yml
  /project/config.yml         → v2  (modified)
```

Show version history for a specific file by passing it as an argument:

```sh
avanti log config.yml
```

```text
/project/config.yml

  v3  2026-05-08 14:32:11  pull a1b2c3d4  (current)
  v2  2026-05-07 09:15:44  pull 7f8e9a0b
  v0  —                    —              (original, before avanti)
```

`v0` is the content the file had before avanti ever touched it. If the file did not exist before avanti, `v0` is not shown.

### `avanti diff <pullId>`

Preview what would change if you reverted to a specific past pull state — without applying anything. Use the short pull ID shown in `avanti log`:

```sh
avanti diff 7f8e9a0b
```

Exits `0` if the current files already match that state, `1` if there are differences.

### `avanti revert [pullId]`

Atomically revert **all** project files to a past state. Revert always operates on the whole project — there is no per-file revert.

**Undo the last pull** (no argument):

```sh
avanti revert
```

**Revert to a specific past pull** (files are restored to the state they were in after that pull):

```sh
avanti revert 7f8e9a0b
```

Files written by pulls after the target are handled automatically: if avanti created them, they are deleted; if they existed before avanti, their original content is restored.

The command always shows a diff before prompting. Use `--yes` to skip the prompt:

```sh
avanti revert 7f8e9a0b --yes
```

The history log is not modified by a revert. The next `avanti pull` after a revert records a new history entry as usual.

### `avanti reset`

Restore **all** tracked files to their state before avanti ever touched them. Files avanti created are deleted; files avanti modified are restored to their original content:

```sh
avanti reset
```

```text
This will restore 4 tracked file(s) to their pre-avanti state:
  /project/config.yml  v3 → v0 (original)
  /project/deploy.sh   v2 → delete (did not exist before avanti)

Apply? [y/N]
```

Use `--yes` to skip the prompt. The history log is preserved — you can still run `avanti log` after a reset.
