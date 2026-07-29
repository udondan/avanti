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

## Working Directory

Relative `src` and `target` paths are resolved against different bases:

- **`target` paths** (map keys) — resolved relative to the **working directory** (where you invoke `avanti`, or the path given with `-w`). This controls where pulled files land on disk.
- **`src` paths** (plain string, for fetching content, and `path:` object sources) — resolved relative to the **config file's location**. If the config is a local file, relative sources resolve relative to its directory. If the config is remote (GitHub, GitLab, HTTPS, `git+ssh://`), relative plain-string sources resolve to the same remote location; `path:` object sources (which always refer to the local filesystem) fall back to resolving against the working directory instead, since a remote config has no local directory to be relative to. **Exception:** when `symlink:` is set, `src` is the symlink target path (always a local filesystem path) and resolves against the working directory — it is never config-relative.

This means a config at `./configs/avanti.yml` can use `src: ./templates/foo.sh` to reference `./configs/templates/foo.sh`, regardless of what working directory you pass with `-w`.

For remote configs, relative source paths are resolved within the same remote context:

```yaml
# config loaded from github:owner/repo:configs/avanti.yml
files:
  dist/script.sh:
    src: ./scripts/build.sh # fetches github:owner/repo:configs/scripts/build.sh
```

The `path:` object source always refers to the local filesystem. For a local config it resolves relative to the config file's directory, same as plain-string `src`; for a remote config it resolves relative to the working directory instead, since there is no local directory to be relative to. To force a `path:` (or any other) source to resolve against the working directory explicitly regardless of the config's location, use the `$workingDir` variable:

```yaml
files:
  target/file:
    src:
      path: $workingDir/local-only-file.txt
```

This is independent of where the config file lives only for targets. A config loaded from another location with `-c /shared/avanti.yml` writes target files into your working directory but reads sources from `/shared/`.

The path given to `-w` supports tilde expansion: `~` resolves to the home directory and `~/some/path` resolves to a subdirectory of it:

```sh
avanti -w ~ pull              # home directory as working dir
avanti -w ~/projects/foo pull # subdirectory of home
```

Use `-w` to deploy the same config to multiple locations without `cd`-ing there first:

```sh
avanti -c /shared/avanti.yml -w /project-a pull
avanti -c /shared/avanti.yml -w /project-b pull
```

### Path Constraints

Avanti enforces that target paths cannot escape the working directory:

- **Relative targets** are resolved under the working directory. A path like `../../etc/passwd` is rejected.
- **Absolute targets** (e.g. `/etc/hosts`) are only permitted when the working directory is `/`. If your working directory is any other path, absolute targets are an error.
- **Home-directory targets** (`~/…`) are expanded to the home directory and then subject to the same working-directory constraint — the expanded path must fall within the working directory. The most common case is running `avanti` from `~` so that all `~/…` targets resolve within it.

These rules apply to `target` values in your config. Source (`src`) paths are reads-only and are not restricted.

## Configuration

Create one of the following files in your project root (searched in this order, case-insensitive):

- `.avanti.yml`
- `.avanti.yaml`
- `avanti.yml`
- `avanti.yaml`

Example:

```yaml
variables:
  email: you@example.com

files:
  my-example.yml:
    src: http://www.example.com/example.yml
    replace:
      - from: '{EMAIL}'
        to: $email
      - from: /\d+/
        to: number

  file.sh:
    src: ~/some/local/file.sh
    mode: '0777'

  some-file.yml:
    src:
      exec: glab api "projects/group%2Fproject/repository/files/some-file.yaml/raw?ref=main"
    on:
      write: sed -e 's/v3/v4/g'

  renovate.json:
    src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: $latest

  local-scripts/:
    src:
      github:
        repo: org/repo
        file: scripts/
        ref: main
```

### File Entry Fields

The `files` key is a **map** — each key is the local target path, and the value is the entry configuration:

```yaml
files:
  <target-path>:
    src: ...
    # optional fields below
```

End the target path with `/` to write a directory source as a mirror; omit the trailing slash to merge all files from the directory into a single output file (YAML/JSON auto-detected by extension, or forced with `yaml:`/`json:`).

**Brace expansion** — use `{a,b,c}` in the target key to declare multiple entries from a single block. The config is equivalent to repeating the block for each alternative:

```yaml
files:
  config/{dev,staging,prod}.yml:
    src:
      github:
        repo: my-org/configs
        file: $filename
```

This is identical to three separate entries for `config/dev.yml`, `config/staging.yml`, and `config/prod.yml`. Per-entry variables like `$filename`, `$basename`, and `$dirname` are derived from each expanded path, so they can be used directly in source fields (as above). Multiple brace groups in a single key are expanded as a cross-product: `{a,b}/{x,y}` produces four entries.

A brace group is only expanded when it contains **at least one comma** (e.g. `{foo,bar}`). A group without a comma — such as `{foo}` — is left as a literal brace sequence and is not expanded. This matches standard shell behavior and means filenames that happen to contain `{` or `}` (e.g. route patterns like `{id}`) require no escaping. YAML quoting is still required when the key itself starts with `{` — see the note below. A single key may produce at most 100 expanded entries; exceeding this limit throws a parse error.

> **YAML quoting:** YAML treats `{` at the start of a plain key as a flow mapping. If the brace group is the first character of a key, quote it: `'{dev,prod}.yml':` or `"{dev,prod}.yml":`. Keys where the brace group appears after a path prefix (e.g. `config/{dev,prod}.yml`) do not need quoting.

| Field           | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`           | Yes      | Source (see below). May be a single source or a **list** of sources to concatenate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `if`            | No       | Condition object (or list of objects). All must pass for the entry to be processed. See [Conditions](#conditions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ifAny`         | No       | List of condition objects. At least one must pass. See [Conditions](#conditions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mode`          | No       | File permission mode. Use a quoted octal string (`"0755"`) or a YAML octal literal (`0o755`). Mode-only changes (content unchanged) are detected by `diff` and applied by `pull`. **POSIX only** — ignored on Windows.                                                                                                                                                                                                                                                                                                                                                                                              |
| `backup`        | No       | Path to copy the current file to before overwriting it. Supports path variables (`$dirname`, `$filename`, `$datetime`) and the `%d+` counter token for auto-incrementing slots. See [Backup](#backup).                                                                                                                                                                                                                                                                                                                                                                                                              |
| `replace`       | No       | List of `{from, to}` replacement rules. `from` may be a plain string or `/pattern/flags` regex.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `on`            | No       | Lifecycle event hooks. See [Event Hooks](#event-hooks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `template`      | No       | Treat the fetched content as a template and render it with avanti config variables as context. See [Template Rendering](#template-rendering).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `json`          | No       | JSON merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.json` or `.jsonc` extension. Use `true`/`false` to force on or off regardless of extension.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `yaml`          | No       | YAML merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.yaml` or `.yml` extension. Use `true`/`false` to force on or off regardless of extension. Comments are preserved in merged output.                                                                                                                                                                                                                                                                                                                                                                             |
| `toml`          | No       | TOML merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.toml` extension. Use `true`/`false` to force on or off regardless of extension. See [TOML Merging](#toml-merging).                                                                                                                                                                                                                                                                                                                                                                                             |
| `ini`           | No       | INI merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.ini` or `.cfg` extension. Use `true`/`false` to force on or off regardless of extension. Comments and key order are preserved. See [INI Merging](#ini-merging).                                                                                                                                                                                                                                                                                                                                                 |
| `strategy`      | No       | Write strategy: `replace` _(default)_ — overwrite the target file entirely; `insert` — merge content into the existing file without clobbering unrelated content. See [Insert Mode](#insert-mode).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `writeInPlace`  | No       | If `true`, replaces file content in-place instead of using an atomic rename. Preserves the existing inode. **Not atomic** — use only when inode stability is required. Errors if the target is a symlink. See [Write in Place](#write-in-place).                                                                                                                                                                                                                                                                                                                                                                    |
| `followSymlink` | No       | If `true` and the target path is a symlink, writes the fetched content to the **symlink's target** instead of replacing the symlink itself. The resolved target must not be a directory and must stay inside the working directory. See [Follow Symlink](#follow-symlink).                                                                                                                                                                                                                                                                                                                                          |
| `symlink`       | No       | Create a symlink at the target path instead of writing file content. `src` must be a single local path. Use `true` or `"absolute"` to create an absolute symlink; use `"relative"` to express the symlink target as a path relative to the symlink's parent directory. Cannot be combined with `replace`, `template`, `json`, `yaml`, `toml`, `ini`, `on.write`, `extract`, `writeInPlace`, `strategy`, `followSymlink`, `mode`, or a list `src`. See [Symlink](#symlink).                                                                                                                                          |
| `extract`       | No       | Unpack an archive (`.zip`, `.tar`, `.tar.gz`, `.tgz`) downloaded from a single-file source before writing. Target must end with `"/"`. Use `true` to extract all files, or a list of patterns to extract only matching entries. Cannot be combined with a list `src`. See [Extract](#extract).                                                                                                                                                                                                                                                                                                                      |
| `sudo`          | No       | Write the file using elevated privileges. Use `true` to write as root, or a username string (e.g. `"www-data"`) to write as a specific user via `sudo -u`. avanti authenticates once per distinct identity before any writes — the OS sudo credential cache is reused for all subsequent operations within the same pull session. **POSIX only** — `pull` errors on Windows when any file has `sudo` set. **Note:** `sudo` is honored by `pull` only (including stale-file cleanup). The `revert` and `reset` commands restore files using normal (non-elevated) file operations and will fail on root-owned paths. |

### Source Types

**Plain string** — HTTP/HTTPS URL, local path, or remote source spec (`github:`, `gitlab:`, `git+ssh://`, etc.):

```yaml
src: https://example.com/file.txt
src: ~/templates/file.txt
src: /absolute/path/file.txt
src: ./relative/path/file.txt   # relative to the config file's directory
```

Relative paths (no leading `/` or `~/`) are resolved relative to the config file's location, not the working directory. If the config is a local file at `./configs/avanti.yml`, then `src: ./scripts/build.sh` fetches `./configs/scripts/build.sh`. For remote configs, a relative src resolves within the same remote context — it becomes a remote source of the same type, not a local file:

- Config `github:owner/repo:configs/avanti.yml` + `src: ./scripts/build.sh` → fetches `github:owner/repo:configs/scripts/build.sh`
- Config `https://example.com/configs/avanti.yml` + `src: ./scripts/build.sh` → fetches `https://example.com/configs/scripts/build.sh`
- Config `git+ssh://git@host/org/repo.git//configs/avanti.yml@main` + `src: ./scripts/build.sh` → fetches `git+ssh://git@host/org/repo.git//configs/scripts/build.sh@main`

**Map** — for path, url, exec, gitlab, github, bitbucket, git, aws_s3,
aws_secrets_manager, aws_systems_manager_parameter, vault, http, raw:

```yaml
src:
  path: ~/templates/file.txt    # explicit local path; supports optional and sha
  optional: true                # silently skip if the file does not exist
  sha: abc123...

src:
  url: https://example.com/file.txt  # explicit http/https URL; supports optional and sha
  optional: true                     # silently skip if the URL returns 404
  sha: abc123...

src:
  exec: <shell command>          # stdout becomes file content; target required
  sha: abc123...                 # optional SHA-256 to verify stdout (see below)

src:
  raw: |                         # inline content; target required
    your content here

src:
  http: https://example.com/file.txt  # explicit http/https URL with optional SHA
  sha: abc123...

src:
  gitlab:
    project: group/repo          # GitLab project path
    file: path/to/file.txt       # file or directory in repo (mutually exclusive with release)
    ref: main                    # branch, tag, $latest, $recent, or /pattern/ (optional)
    sha: abc123...               # optional SHA-256 fingerprint
    host: gitlab.mycompany.com   # override default gitlab.com (optional)
    via: cli                     # api, cli, or list (default: [api, cli])

# GitLab release artifacts — downloads package-type links (falls back to all links)
src:
  gitlab:
    project: group/repo          # GitLab project path
    release: v1.2.3              # release tag, $latest, $recent, or /pattern/ (mutually exclusive with file)
    sha: abc123...               # optional SHA-256 fingerprint
    host: gitlab.mycompany.com   # override default gitlab.com (optional)
    via: cli                     # api, cli, or list (default: [api, cli])
  filter:                        # optional: keep only matching assets (see below)
    - installer.deb
    - checksums-{amd64,arm64}.txt

src:
  github:
    repo: owner/repo             # GitHub owner/repo
    file: path/to/file.txt       # file or directory in repo (mutually exclusive with release)
    ref: main                    # branch, tag, $latest, $recent, or /pattern/ (optional)
    sha: abc123...               # optional SHA-256 fingerprint
    host: github.mycompany.com   # GitHub Enterprise Server hostname (optional)
    via: cli                     # api, cli, or list (default: [api, cli])

# GitHub release artifacts — downloads all assets attached to a release
src:
  github:
    repo: owner/repo             # GitHub owner/repo
    release: v1.2.3              # release tag, $latest, $recent, or /pattern/ (mutually exclusive with file)
    sha: abc123...               # optional SHA-256 fingerprint
    host: github.mycompany.com   # GitHub Enterprise Server hostname (optional)
    via: cli                     # api, cli, or list (default: [api, cli])
  filter:                        # optional: keep only matching assets (see below)
    - exact-match.png
    - file-{a,b,c}.yml
    - /^some.*\.jpg/

src:
  bitbucket:
    workspace: my-workspace      # Bitbucket workspace slug
    repo: my-repo                # repository slug
    file: path/to/file.txt       # file or directory in repo
    ref: main                    # branch, tag, or $latest (optional)
    sha: abc123...               # optional SHA-256 fingerprint
    host: bitbucket.mycompany.com  # override default api.bitbucket.org (optional)

src:
  git:
    repo: https://github.com/org/repo.git  # any git remote (HTTPS or SSH)
    file: path/to/file.txt                 # file or directory in repo
    ref: main                              # branch, tag, or commit hash (optional)
    sha: abc123...                         # optional SHA-256 fingerprint

# git+ssh:// (and git://, ssh://) also work as plain strings or url: values using
# double-slash to separate the repo URL from the file path inside the repo:
src: git+ssh://git@ssh.git.private.de/org/repo.git//path/to/file.txt
src: git+ssh://git@ssh.git.private.de/org/repo.git//path/to/file.txt@main

src:
  url: git+ssh://git@ssh.git.private.de/org/repo.git//path/to/file.txt@main

src:
  aws_s3: s3://my-bucket/path/to/file.txt  # end with / for a prefix sync
  sha: abc123...                           # optional SHA-256 fingerprint

src:
  aws_secrets_manager:
    name: myapp/prod/db         # secret name or ARN
    key: password               # optional: extract one field from a JSON secret
    region: us-east-1           # optional: AWS region (default: SDK chain)
    sha: abc123...              # optional SHA-256 fingerprint

src:
  aws_systems_manager_parameter:
    name: /myapp/prod/db-host   # parameter name; end with / for path prefix fetch
    region: us-east-1           # optional: AWS region (default: SDK chain)
    sha: abc123...              # optional SHA-256 fingerprint

src:
  vault:
    path: secret/myapp/config   # Vault KV path (mount/subpath)
    field: db_password          # specific field to extract (optional; omit for full JSON)
    sha: abc123...              # optional SHA-256 fingerprint
```

#### SHA pinning

The optional `sha` field pins a source to a specific content fingerprint. When present, avanti verifies the SHA-256 of the raw fetched content matches before writing anything. This makes your config act as a selective lockfile — only sources you care about get pinned, and changes are surfaced explicitly rather than applied silently.

Use `avanti lock` to compute and write SHA values automatically. Use `avanti pull --accept-changes` to review a mismatch and update the pinned SHA. Plain string sources (a bare local path or URL string) and `raw:` sources do not support `sha`. Use the explicit `path:` or `url:` map form to pin a local file or HTTP URL.

#### Filter

The optional `filter` field narrows which files are kept when a source returns multiple files (directory sources, release artifacts, S3 prefixes). It is supported on `path:`, `github:`, `gitlab:`, `bitbucket:`, `git:`, and `aws_s3:` sources.

`filter` is a list of one or more patterns. A file is kept if **any** pattern matches its path relative to the source root (the filename for flat sources like release assets, or the relative path for directory sources). Paths are always matched using forward slashes (`/`) regardless of the platform — on Windows, write `subdir/file.yml`, not `subdir\file.yml`.

| Pattern                 | Matches                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `exact.png`             | Exact string equality                                                                  |
| `subdir/`               | Directory prefix — all entries whose path starts with `subdir/`                        |
| `file-{a,b,c}.yml`      | Brace-expanded alternatives — `file-a.yml`, `file-b.yml`, `file-c.yml`                 |
| `tool_*_darwin_arm64.*` | Glob — `*` matches any sequence of characters, `?` matches any single character        |
| `/^some.*\.jpg/`        | JavaScript regular expression (delimited by `/`) tested against the full relative path |

```yaml
files:
  assets/:
    src:
      github:
        repo: owner/repo
        release: $latest
      filter:
        - exact-match.png
        - dist/ # all files under dist/
        - checksums-{amd64,arm64}.txt
        - tool_*_darwin_arm64.tar.gz
        - /^some.*\.jpg/
```

Variables are resolved in filter patterns before matching, so patterns like `$env:ARCH.tar.gz` or `$platform-release.zip` work as expected. An error is raised if the filter matches zero files, preventing silent misconfiguration. The `sha` fingerprint (if present) is computed over the filtered set.

> **Note:** brace expansion is not supported in directory-prefix patterns (patterns ending with `/`). Use separate patterns instead — e.g. `"core/"` and `"utils/"` rather than `"{core,utils}/"`.

#### Extract

The optional `extract` field unpacks a downloaded archive before writing files. It applies to any single-file source (HTTP URL, local path, etc.) that returns an archive. Set `extract: true` to extract all entries, or provide a list of patterns to keep only matching entries.

**The target must be a directory** (end with `/`). Archive extraction writes multiple files; a non-directory target is rejected at parse time.

| Format     | Extensions        |
| ---------- | ----------------- |
| ZIP        | `.zip`            |
| tar        | `.tar`            |
| tar + gzip | `.tar.gz`, `.tgz` |

Patterns use the same syntax as [`filter`](#filter):

| Pattern       | Matches                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `exact.png`   | Exact string equality                                                                  |
| `subdir/`     | Directory prefix — all entries whose path starts with `subdir/`                        |
| `{a,b,c}.yml` | Brace-expanded alternatives                                                            |
| `/^.*\.jpg/`  | JavaScript regular expression (delimited by `/`) tested against the full relative path |

> **Note:** brace expansion is not supported in directory-prefix patterns (patterns ending with `/`). Use separate patterns instead — e.g. `"core/"` and `"utils/"` rather than `"{core,utils}/"`.

```yaml
files:
  # Extract all files from a release archive into a local directory
  tools/:
    src: https://example.com/release.tar.gz
    extract: true

  # Extract only matching entries
  assets/:
    src: https://example.com/bundle.zip
    extract:
      - readme.md # exact match
      - images/ # all entries under images/
      - libs/{core,utils}.js # brace expansion (not with trailing /)
      - /^assets\/.*\.png$/ # regex
```

Variables are resolved in patterns before matching. An error is raised if the pattern list matches zero entries. `extract` cannot be combined with a list `src`. Entry paths are validated — archives containing path-traversal sequences (`../`) or absolute paths are rejected for security. The `sha` fingerprint (if present) is computed over the archive before extraction.

### Directory Sources

Any source type that references a path (local, GitLab, GitHub, Bitbucket, git, S3) can point to a directory instead of a single file. End the path with `/` to declare it a directory explicitly; without a trailing slash the tool probes the remote to decide.

**Directory → directory (mirror):** end the target key with `/` and each file is written individually, preserving subdirectory structure relative to the source root:

```yaml
files:
  # All files under skills/ in the GitLab repo are written into local skills/
  skills/:
    src:
      gitlab:
        project: group/repo
        file: skills/
        ref: main

  # GitHub directory → local directory
  .github/workflows/:
    src:
      github:
        repo: org/repo
        file: .github/workflows/
        ref: main

  # Bitbucket directory → local directory
  eslint/:
    src:
      bitbucket:
        workspace: my-workspace
        repo: shared-configs
        file: eslint/
        ref: main

  # git remote directory → local directory (any host)
  .github/actions/:
    src:
      git:
        repo: https://github.com/org/repo.git
        file: .github/actions/
        ref: main

  # S3 prefix → local directory (trailing / triggers sync)
  configs/:
    src:
      aws_s3: s3://my-bucket/configs/

  # Local directory → local directory
  .githooks/:
    src: ~/shared/hooks/
```

**Directory → single file (merge):** omit the trailing `/` from the target key and all files in the directory are merged into one. Files are sorted alphabetically — later names win on key conflicts. YAML/JSON merge is auto-detected from the contained file extensions, or forced with `yaml:`/`json:`:

```yaml
files:
  # One folder per service, each a separate .yml file → single docker-compose.yml
  docker-compose.yml:
    src: ./services/

  # JSON: one file per environment → merged config
  config.json:
    src: ./config/
```

With explicit YAML merge options (e.g. to concat arrays instead of replacing):

```yaml
files:
  docker-compose.yml:
    src: ./services/
    yaml:
      arrays: concat
```

Directory sources cannot be mixed into a multi-source list (`src` as a list), because the list mode always produces a single file.

**List** — combine multiple sources into one file (all source types supported):

```yaml
files:
  combined.txt:
    src:
      - https://example.com/header.txt
      - exec: echo "# generated"
      - gitlab:
          project: org/repo
          file: footer.txt
          ref: main
```

Sources are fetched in order and joined with a newline. Post-processing (`replace`, `on.write`) is applied to the combined result. If any source fails, the entire entry is aborted.

### JSON Merging

When all sources in a list have a `.json` or `.jsonc` extension, JSON merging is enabled automatically — no extra config needed:

```yaml
files:
  merged.jsonc:
    src:
      - ./team.jsonc
      - ./my.jsonc
```

To merge sources that don't have a JSON extension (e.g. `exec:`, `raw:`, or a URL without `.json`), set `json: true`:

```yaml
files:
  merged.json:
    src:
      - exec: cat defaults.json
      - ./overrides.json
    json: true
```

To opt out of auto-detection and force plain concatenation, set `json: false`.

**Fine-grained options** — pass an object to control merge behavior:

```yaml
files:
  merged.json:
    src:
      - ./defaults.json
      - github:
          repo: org/configs
          file: overrides.json
    json:
      conflicts: last_wins # abort | first_wins | last_wins (default)
      arrays: replace # replace (default) | concat | dedupe
      objects: merge # merge (default) | replace
      indent: 2 # number of spaces, or "tab"
      trailing_commas: false # add trailing comma after last item (valid JSONC)
      sort_keys: false # sort object keys alphabetically
      minify: false # collapse to single line, strips comments
      strip_comments: false # remove JSONC comments from output
```

- `conflicts` — what to do when the same key holds a scalar (or an array/object when their strategy is `replace`):
  - `last_wins` _(default)_ — the last source's value wins
  - `first_wins` — the first source's value is kept
  - `abort` — throw an error (identical values are not considered a conflict)
- `arrays` — how to combine arrays at the same key:
  - `replace` _(default)_ — the later source's array replaces the earlier one
  - `concat` — arrays are concatenated (no deduplication)
  - `dedupe` — items from the later source are appended only if not already present in the base (set-union, deep equality, order preserved)
- `objects` — how to combine objects (maps) at the same key:
  - `merge` _(default)_ — deep merge, applying the same rules recursively to nested keys
  - `replace` — the later source's object replaces the earlier one entirely
- `indent` _(default: `2`)_ — indentation: a non-negative integer for spaces, or `"tab"` for tab characters
- `trailing_commas` _(default: `false`)_ — append a trailing comma after the last element in every array and object; valid JSONC syntax that produces cleaner diffs
- `sort_keys` _(default: `false`)_ — sort all object keys alphabetically (recursive); useful for stable diffs regardless of insertion order; rebuilds objects from scratch so JSONC comments are not preserved in the output
- `minify` _(default: `false`)_ — collapse output to a single line with no whitespace; also strips JSONC comments since they are not valid in strict JSON; overrides `indent` and `trailing_commas`
- `strip_comments` _(default: `false`)_ — remove all JSONC comments from the output, producing valid strict JSON; also overrides `trailing_commas` (strict JSON does not support trailing commas)

**Pretty-printing a single file** — `json` works on single-source entries too. Auto-detection applies here as well, so a single `.json` source is pretty-printed automatically:

```yaml
files:
  pretty.json:
    src: ./minified.json
```

### YAML Merging

When all sources in a list have a `.yaml` or `.yml` extension, YAML merging is enabled automatically — no extra config needed:

```yaml
files:
  merged.yaml:
    src:
      - ./defaults.yaml
      - ./overrides.yml
```

To merge sources that don't have a YAML extension (e.g. `exec:`, `raw:`, or a URL without `.yaml`), set `yaml: true`:

```yaml
files:
  merged.yaml:
    src:
      - exec: cat defaults.yaml
      - ./overrides.yaml
    yaml: true
```

To opt out of auto-detection and force plain concatenation, set `yaml: false`.

**Fine-grained options** — pass an object to control merge behavior:

```yaml
files:
  merged.yaml:
    src:
      - ./defaults.yaml
      - github:
          repo: org/configs
          file: overrides.yaml
    yaml:
      conflicts: last_wins # abort | first_wins | last_wins (default)
      arrays: replace # replace (default) | concat | dedupe
      objects: merge # merge (default) | replace
```

The options behave identically to JSON merging:

- `conflicts` — what to do when the same key holds a scalar (or an array/object when their strategy is `replace`):
  - `last_wins` _(default)_ — the last source's value wins
  - `first_wins` — the first source's value is kept
  - `abort` — throw an error (identical values are not considered a conflict)
- `arrays` — how to combine arrays at the same key:
  - `replace` _(default)_ — the later source's array replaces the earlier one
  - `concat` — arrays are concatenated (no deduplication)
  - `dedupe` — items from the later source are appended only if not already present in the base (set-union, deep equality, order preserved)
- `objects` — how to combine objects (maps) at the same key:
  - `merge` _(default)_ — deep merge, applying the same rules recursively to nested keys
  - `replace` — the later source's object replaces the earlier one entirely

**Comment preservation** — YAML comments are preserved in the merged output. Comments from all sources are retained in their original positions.

**Pretty-printing a single file** — `yaml` works on single-source entries too. Auto-detection applies here as well, so a single `.yaml` or `.yml` source is normalized automatically:

```yaml
files:
  config.yaml:
    src: ./config.yaml
```

### TOML Merging

When all sources in a list have a `.toml` extension, TOML merging is enabled
automatically — no extra config needed:

```yaml
files:
  merged.toml:
    src:
      - ./defaults.toml
      - ./overrides.toml
```

To merge sources that don't have a TOML extension (e.g. `exec:`, `raw:`, or a URL without `.toml`), set `toml: true`:

```yaml
files:
  merged.toml:
    src:
      - exec: cat defaults.toml
      - ./overrides.toml
    toml: true
```

To opt out of auto-detection and force plain concatenation, set `toml: false`.

**Fine-grained options** — pass an object to control merge behavior:

```yaml
files:
  merged.toml:
    src:
      - ./defaults.toml
      - github:
          repo: org/configs
          file: overrides.toml
    toml:
      conflicts: last_wins # abort | first_wins | last_wins (default)
      arrays: replace # replace (default) | concat | dedupe
      objects: merge # merge (default) | replace
```

The options behave identically to JSON and YAML merging:

- `conflicts` — what to do when the same key holds a scalar (or an array/object when their strategy is `replace`):
  - `last_wins` _(default)_ — the last source's value wins
  - `first_wins` — the first source's value is kept
  - `abort` — throw an error (identical values are not considered a conflict)
- `arrays` — how to combine arrays at the same key:
  - `replace` _(default)_ — the later source's array replaces the earlier one
  - `concat` — arrays are concatenated (no deduplication)
  - `dedupe` — items from the later source are appended only if not already present in the base (set-union, deep equality, order preserved)
- `objects` — how to combine objects (tables) at the same key:
  - `merge` _(default)_ — deep merge, applying the same rules recursively to nested keys
  - `replace` — the later source's table replaces the earlier one entirely

> **Note:** TOML comments are **not preserved** in the merged or formatted
> output. TOML parsers do not support comment round-tripping.

**Pretty-printing a single file** — `toml` works on single-source entries too.
Auto-detection applies here as well, so a single `.toml` source is normalized
automatically:

```yaml
files:
  config.toml:
    src: ./config.toml
```

### INI Merging

When all sources in a list have a `.ini` or `.cfg` extension, INI merging is enabled
automatically — no extra config needed:

```yaml
files:
  merged.ini:
    src:
      - ./defaults.ini
      - ./overrides.ini
```

To merge sources that don't have an INI extension (e.g. `exec:`, `raw:`, or a URL without `.ini`), set `ini: true`:

```yaml
files:
  merged.ini:
    src:
      - exec: cat defaults.ini
      - ./overrides.ini
    ini: true
```

To opt out of auto-detection and force plain concatenation, set `ini: false`.

**Fine-grained options** — pass an object to control merge behavior:

```yaml
files:
  merged.ini:
    src:
      - ./defaults.ini
      - github:
          repo: org/configs
          file: overrides.ini
    ini:
      conflicts: last_wins # abort | first_wins | last_wins (default)
      arrays: replace # replace (default) | concat | dedupe
      objects: merge # merge (default) | replace
```

The options behave identically to JSON, YAML, and TOML merging:

- `conflicts` — what to do when the same key holds a scalar (or an array/object when their strategy is `replace`):
  - `last_wins` _(default)_ — the last source's value wins
  - `first_wins` — the first source's value is kept
  - `abort` — throw an error (identical values are not considered a conflict)
- `arrays` — how to combine arrays at the same key (written as `key[] = val` in INI):
  - `replace` _(default)_ — the later source's array replaces the earlier one
  - `concat` — arrays are concatenated (no deduplication)
  - `dedupe` — items from the later source are appended only if not already present
- `objects` — how to combine sections at the same name:
  - `merge` _(default)_ — deep merge, applying the same rules recursively to section keys
  - `replace` — the later source's section replaces the earlier one entirely

**Comments and key order are preserved in the base (first) source.** The INI processor uses
a line-level AST, so comment lines, inline comments, and blank lines from the first source
are preserved through the merge. Minor whitespace normalization may occur (e.g. a single
space is inserted before inline comments, and spacing around `=` follows the base key's
original separator). When a key's value is updated by a later source, the base key's inline
comment is kept and the key stays at its original position — it is not shuffled to the end.
**Comment behavior under `objects: merge` (default):** Comment lines (`; ...` / `# ...`),
blank lines, and section header comments from overlay sources are not transferred when merging
individual keys. For keys that already exist in the base, the base key's inline comment is
kept. For new keys introduced only by the overlay, their inline comments are preserved (there
is no base inline comment to fall back on). When a new section is introduced by the overlay
(one that does not exist in the base), it is inserted without its section header comment or
any internal comment/blank nodes — only its key-value pairs are carried over.

**Comment behavior under `objects: replace`:** When the overlay section's key-value content
differs from the base, the entire overlay section is used as-is — including its section
header comment, internal comment lines, blank lines, and inline comments. If the two sections
have identical key-value content (even when they differ only in comments or whitespace), no
replacement occurs — the base section is kept unchanged.

**Inline comment limitation for arrays:** When the same key appears as multiple `key[] = val`
entries, all values are coalesced into a single array node. Only the inline comment from the
_first_ occurrence (if any) is preserved; inline comments on subsequent `key[] = val` lines are
discarded.

**Supported INI features:** sections (`[section]`), subsections (`[section "name"]`),
`key = value` pairs, bare keys, quoted values (`"..."` / `'...'`), comment lines (`;` and `#`),
inline comments, blank lines, backslash line continuation, and arrays via `key[] = val`. All
`key[] = val` entries for the same key are collected into one array regardless of position in
the file; non-contiguous entries are normalized to appear at the first occurrence of that key.

**Value coercion:** Unquoted values that match `true` or `false` (case-insensitive) are parsed
as booleans, and values that parse as a valid number are parsed as numbers. This means
`enabled = true` is stored as a boolean and `port = 8080` as a number; on format or merge
these are re-serialised as `true` / `8080` respectively. Strings like `001` are normalised to
`1`. To preserve the exact string form, quote the value: `port = "8080"`.

**Inline comment delimiter:** `;` and `#` are treated as comment delimiters when they appear
outside of quoted strings. If a value contains a literal `;` or `#` character, quote the value
(e.g. `url = "https://example.com#anchor"`) to prevent it from being interpreted as a comment.

**Pretty-printing a single file** — `ini` works on single-source entries too. Auto-detection
applies here as well, so a single `.ini` or `.cfg` source is normalized automatically.

### Template Rendering

Set `template` to treat the fetched content as a template. avanti renders it at deploy time using all avanti config variables as the template context, then writes the rendered output to the target file.

> **Security note** — EJS and Eta templates execute arbitrary JavaScript at render time. Handlebars, Nunjucks, Liquid, and Mustache are logic-limited and do not execute raw JS. For any engine, template sources must be trusted: either authored locally, fetched from a controlled internal source, or SHA-pinned (see [`sha:`](#sha-pinning)). Treat a compromised remote template as equivalent to a compromised `on.write` script or `exec:` source.

```yaml
variables:
  env: production
  region: us-east-1

files:
  deploy-config.txt:
    src: ./deploy.hbs
    template: handlebars

  k8s-manifest.yaml:
    src: ./manifest.njk
    template: nunjucks # or: template: jinja2 (alias)

  nginx.conf:
    src: ./nginx.conf.liquid
    template: true # auto-detect engine from file extension
```

**Supported engines:**

| Engine       | Value        | Variable syntax  | Auto-detected extensions           |
| ------------ | ------------ | ---------------- | ---------------------------------- |
| Handlebars   | `handlebars` | `{{varName}}`    | `.hbs`, `.handlebars`              |
| Nunjucks     | `nunjucks`   | `{{ varName }}`  | `.njk`, `.j2`, `.jinja`, `.jinja2` |
| Jinja2 alias | `jinja2`     | `{{ varName }}`  | _(same as nunjucks)_               |
| Liquid       | `liquidjs`   | `{{ varName }}`  | `.liquid`                          |
| EJS          | `ejs`        | `<%= varName %>` | `.ejs`                             |
| Mustache     | `mustache`   | `{{varName}}`    | `.mustache`, `.mst`                |
| Eta          | `eta`        | `<%= varName %>` | `.eta`                             |

All engines are configured with HTML escaping **disabled** — variable values are written verbatim, without converting `&`, `<`, `>`, `"`, or `'` to HTML entities.

`template: true` infers the engine from the source file's extension (including the filename extracted from a URL). Use an explicit engine name when the extension is absent or unrecognised — e.g. `exec:` sources, `raw:` sources, or URLs whose path has no recognised template extension.

For multi-source arrays (`src: [a, b, c]`) and directory-to-single-file merges, all sources are concatenated or merged into a single buffer before rendering, and the key used for auto-detection is `path.basename(entry.target)`. In those cases, use an explicit engine name unless the target filename itself has a recognised template extension.

**`jinja2` alias** — `template: jinja2` is equivalent to `template: nunjucks`. Nunjucks is a JavaScript implementation heavily inspired by Jinja2; most Jinja2 templates work without changes.

**Pipeline order** — template rendering runs first, before `replace` and `on.write`. Subsequent processors receive the already-rendered content.

### Event Hooks

The `on:` field on a file entry lets you run shell commands at specific points in the file lifecycle. `on.write` supports avanti variable substitution (same rules as `exec:` and `replace:`). Side-effect hooks (`before*`, `create`, `update`) are passed to the shell verbatim — use `$AVANTI_TARGET` and `$AVANTI_IS_NEW` as environment variables.

| Hook              | When                                                                            | Content transform? |
| ----------------- | ------------------------------------------------------------------------------- | ------------------ |
| `on.write`        | During processing, after `replace`; stdin → stdout replaces content             | Yes                |
| `on.beforeWrite`  | After user confirms, before writing — fires for every changed file              | No                 |
| `on.beforeCreate` | Same timing, but only when the file is being **created** for the first time     | No                 |
| `on.beforeUpdate` | Same timing, but only when the file already **exists** and has changed          | No                 |
| `on.create`       | After the file has been successfully written — new files only                   | No                 |
| `on.update`       | After the file has been successfully written — existing files with changes only | No                 |

Side-effect hooks (`before*`, `create`, `update`) receive two environment variables:

| Variable        | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| `AVANTI_TARGET` | Absolute path of the target file                            |
| `AVANTI_IS_NEW` | `"true"` if the file is being created; `"false"` if updated |

On Unix, access them as `$AVANTI_TARGET` / `$AVANTI_IS_NEW`. On Windows (PowerShell), avanti automatically injects a prelude that maps these to local variables, so `$AVANTI_TARGET` works identically — you do not need to write `$env:AVANTI_TARGET`.

Only hooks for files with **actual changes** are fired (`create`/`update`/`before*` are silent no-ops when content and mode are unchanged).

```yaml
files:
  config/app.yml:
    src: https://config.example.com/app.yml
    on:
      write: sed -e 's/v3/v4/g' # transform content
      beforeCreate: mkdir -p "$(dirname "$AVANTI_TARGET")"
      create: echo "Created $AVANTI_TARGET"
      update: git add "$AVANTI_TARGET"
```

### Insert Mode

By default (`strategy: replace`) avanti overwrites the target file with the fully processed source content. Set `strategy: insert` to **merge** content into an existing file instead of replacing it.

```yaml
files:
  .vscode/settings.json:
    src: ./shared/vscode-settings.json
    json: true
    strategy: insert
```

**How it works:**

- **First run** — the fetched content is merged into the existing file (or written as-is if the file does not exist yet).
- **Subsequent runs (no-op)** — avanti detects that the raw source and the post-processed output (`replace`/`on.write`) are both unchanged and skips the file entirely.
- **Subsequent runs (source changed)** — avanti removes the keys/text it previously contributed, then merges the updated content in.
- **User edits are preserved** — keys or text the user added or modified are left untouched. If a user overrides an avanti-managed key, avanti will not remove it even if the source no longer includes it.

**Structured files (JSON / YAML / TOML):**

Avanti tracks which keys it contributed in the previous pull. On the next pull it removes only those keys (if they still match) and then merges the new contribution. This means:

- Keys removed from the remote source are removed from the local file.
- Keys the user added or modified independently are preserved.
- Nested objects and arrays are handled recursively. For arrays, combine with `arrays: concat` so avanti appends items; avanti removes only the items it previously appended, leaving user-owned items intact.

```yaml
files:
  tsconfig.json:
    src: https://example.com/shared-tsconfig.json
    json:
      objects: merge
      arrays: concat
    strategy: insert
```

**Plain text:**

On the first insert, the text is appended to the existing file. On subsequent runs, the old block is replaced in-place when the source changes; if it is no longer found (e.g. the user removed it), the new block is appended.

### Conditions

Use `if` and `ifAny` on a file entry or on an individual source to control when it is processed.

**`if`** — a condition object (or list of objects) where **all** checks must pass (AND).

**`ifAny`** — a list of condition objects where **at least one** must pass (OR).

When both are present, both must pass. Each condition object may also include `not: true` to invert its result.

#### Condition fields

| Field           | Type           | Description                                                                                                                     |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `os`            | string or list | Platform must match. Values: `linux`, `mac`, `windows`. Aliases: `darwin` (= `mac`), `win32` (= `windows`). List = any matches. |
| `exists`        | string         | Path (file or directory) must exist. Variables are resolved.                                                                    |
| `exec`          | string         | Shell command must exit with code `0`.                                                                                          |
| `target_exists` | boolean        | `true` — pass only if target exists. `false` — pass only if target does not exist.                                              |
| `not`           | boolean        | `true` — invert the result of all checks in this condition object.                                                              |

#### Examples

```yaml
files:
  # Only on Linux
  /etc/app.conf:
    if:
      os: linux
    src: ...

  # Skip on Windows
  ~/.config/app.conf:
    if:
      os: windows
      not: true
    src: ...

  # Only if Docker is installed
  ~/.docker/config.json:
    if:
      exec: which docker
    src: ...

  # Only update — never create
  ~/.ssh/config:
    if:
      target_exists: true
    src: ...

  # OR: write if on mac OR if app is installed
  app.conf:
    ifAny:
      - os: mac
      - exec: which app
    src: ...

  # Combined AND + OR
  combined.conf:
    if:
      os: windows
      not: true
    ifAny:
      - exists: /opt/app
      - exec: which app
    src: ...
```

Conditions also apply at the **source level** within a multi-source entry (plain string sources excluded — use `path:` or `url:` wrapper form):

```yaml
files:
  platform.conf:
    src:
      - raw: "# linux config\n"
        if:
          os: linux
      - raw: "# mac config\n"
        if:
          os: mac
      - path: /common/base.conf
```

### Scaffold Pattern

A local file can be both a **write target** and a **source** for another entry in the same run. When avanti processes an entry whose source path resolves to a file that is also being written in the same run, it uses the **pending content** — the content that entry would write — rather than whatever is currently on disk. This means the downstream entry sees the final result even if the target file does not exist yet.

This enables a scaffold-and-customize pattern: create a default file on first run, let the user modify it, and automatically incorporate their changes into downstream files on every subsequent run.

```yaml
files:
  # Created once with a default template. Never touched again after the user edits it.
  ./config/team.md:
    src:
      raw: |
        # Team Configuration
        Edit this file to customize your team settings.
    if:
      target_exists: false

  # Always rebuilt. On first run it picks up the default template above.
  # After the user edits team.md, it picks up their version.
  ./docs/handbook.md:
    src:
      - github:
          repo: org/docs
          file: handbook-base.md
          ref: main
      - path: ./config/team.md
```

On **first run**: `team.md` does not exist, so the `raw:` entry creates it. `handbook.md` sources from `team.md` and picks up the default template content — even though `team.md` has not been written to disk yet.

On **subsequent runs**: `team.md` already exists, so the `target_exists: false` condition skips it. `handbook.md` reads `team.md` from disk and picks up any changes the user made.

**Automatic ordering** — avanti resolves dependencies between entries and processes them in the correct order automatically. You can define entries in any order in the config; if entry B sources from entry A's target path, A is always processed before B.

**Cycle detection** — if two entries form a cycle (A sources from B and B sources from A), avanti exits with an error listing the cycle before writing any files.

### Backup

> **Note:** avanti already maintains an internal pull history under `~/.config/avanti/` and you can restore any file with `avanti revert`. The `backup:` field is for additional, fine-grained control — for example, keeping a copy on an external drive, in a dedicated folder, or with a custom naming scheme.

Add `backup:` to a file entry to copy the current file to a backup location before overwriting it:

```yaml
files:
  config.yaml:
    src: github:org/repo/config.yaml
    backup: $dirname/$filename.bkp
```

Backup happens when the target path currently holds a regular file or a symlink — regardless of whether the entry being written is a regular file or a symlink entry. On POSIX, if the existing target is a symlink, the symlink itself (not the file it points to) is preserved in the backup; if the symlink had a relative target, avanti rewrites it to an absolute path so the backup symlink resolves correctly from the backup directory. On Windows, symlink backups are skipped (a warning is printed) because creating a symlink backup requires elevated privileges and dereferencing the link could read files outside the working directory. **Exception:** for regular-file entries with `sudo: true`, only existing regular files are backed up — if the current target is a symlink it is not backed up. For `symlink:` entries with `sudo: true`, the existing symlink (or regular file) at the target path is backed up before being replaced. Directory targets are never backed up. If the backup path already exists it is overwritten — use the [counter pattern](#counter-pattern) or `$datetime` when you want to keep every backup.

#### Path variables

All [system-injected variables](#system-injected-variables) — per-file path variables (`$path`, `$filename`, `$basename`, `$ext`, `$dirname`, `$basedir`), pull-time variables (`$date`, `$datetime`), and system variables (`$os`, `$arch`, `$arch_go`) — are available in `backup:` patterns.

#### Counter pattern

Use `%d+` in the backup path to auto-increment to the lowest unused slot. The number of `d` characters sets the zero-padding width and maximum slot:

| Token  | Slots       |
| ------ | ----------- |
| `%d`   | `1`–`9`     |
| `%dd`  | `01`–`99`   |
| `%ddd` | `001`–`999` |

Only one counter token per backup path is allowed. If all slots are taken, avanti exits with an error.

```yaml
files:
  config.yaml:
    src: github:org/repo/config.yaml
    backup: $dirname/$basename.%dd.$ext # config.01.yaml → config.02.yaml → …
```

#### Security: backup_roots

By default, backup paths are restricted to the working directory — the same constraint applied to target paths. To back up outside the working directory, declare the allowed roots at the top level:

```yaml
backup_roots:
  - ~/backups
  - /mnt/nas/backups

files:
  config.yaml:
    src: github:org/repo/config.yaml
    backup: ~/backups/$filename
```

Each entry in `backup_roots` supports `~/` expansion. Paths not covered by the working directory or a declared root are rejected with an error before any file is written.

#### Backup examples

```yaml
# Same directory, .bkp extension appended
backup: $dirname/$filename.bkp         # /project/config.yaml.bkp

# Separate backup folder within the working directory
backup: backups/$filename              # <workingDir>/backups/config.yaml

# Timestamped — one file per pull
backup: $dirname/$filename.$datetime   # config.yaml.2026-05-20-14-30-00

# Auto-increment — keeps up to 99 rotating backups
backup: $dirname/$basename.%dd.$ext   # config.01.yaml, config.02.yaml, …

# Separate directory outside the working directory (requires backup_roots)
backup: ~/backups/$filename
```

### Write in Place

By default avanti writes files using an atomic rename: content is staged to a temporary file in the same directory, then `rename(2)` replaces the target atomically. This creates a new inode on every pull.

Some environments track files by inode — file watchers (`inotifywait IN_CLOSE_WRITE`), Docker bind-mount hot-reload, certain editors. When the inode changes those watchers lose the file. Set `writeInPlace: true` to replace the file's content in-place instead:

```yaml
files:
  docker/config.json:
    src:
      github:
        repo: org/repo
        file: docker/config.json
    writeInPlace: true
```

|                  | default           | `writeInPlace: true`         |
| ---------------- | ----------------- | ---------------------------- |
| Atomic?          | Yes — `rename(2)` | **No** — truncate then write |
| Inode preserved? | No                | Yes                          |
| New file         | Created normally  | Created normally             |
| Backup           | Yes               | Yes                          |

> **Warning:** `writeInPlace: true` is **not atomic**. Between the truncate and the completed write, a concurrent reader will see empty or partial content. Use the default atomic rename when correctness under concurrent reads matters more than inode stability.

**Write failure recovery:** avanti reads the file's current content before truncating it. If the write fails (disk full, NFS timeout, etc.), avanti automatically restores the original content via an atomic rename. For files larger than 100 MiB without a `backup:` path configured, in-memory recovery is not available — configure `backup:` to ensure the original content can be restored on write failure.

### Follow Symlink

When the target path is a symlink, avanti's default atomic-rename strategy replaces the symlink itself — the symlink is overwritten with the fetched file content. Set `followSymlink: true` to write through the symlink instead: avanti resolves the symlink chain to its real path and writes the content there, leaving the symlink pointer intact.

> **Interaction with `writeInPlace`:** `writeInPlace: true` errors when its target path is a symlink. When combined with `followSymlink: true`, avanti resolves the symlink first and passes the real path to the writer, so `writeInPlace` never sees a symlink. The result: content is written in-place to the real file (inode preserved) while the symlink itself remains intact.

```yaml
files:
  config/settings.json:
    src:
      github:
        repo: org/shared-configs
        file: settings.json
    followSymlink: true
```

This is useful when a symlink is managed by another tool (e.g. a dotfile manager) and must not be replaced. avanti updates the real file's content while the symlink pointer remains unchanged.

**Safety constraints** — avanti validates the resolved target before writing:

- The resolved path must **not be a directory** — avanti refuses to write file content over a directory target.
- The resolved path must remain **inside the working directory** — symlinks that escape (directly or through intermediate symlinked directories) are rejected.
- **Circular symlinks** are detected and rejected.

Dangling symlinks (a symlink chain whose endpoint does not yet exist) are supported: avanti follows the chain to the non-existent endpoint and creates the file there, subject to the same directory and working-directory constraints above.

When the target path does not exist yet, or does not point to a symlink, `followSymlink` has no effect and the file is created or written normally.

### Symlink

Set `symlink: true` (or `symlink: "absolute"`) to create a filesystem symlink at the target path pointing to the `src` path, instead of copying the file's content. The `src` must be a single local path — remote sources (HTTP, GitHub, GitLab, exec, etc.) are not supported.

```yaml
files:
  ~/.config/app/config.yml:
    src: /opt/app/defaults/config.yml
    symlink: true
```

Use `symlink: "relative"` to store the symlink target as a path relative to the symlink's parent directory. This is useful when you want symlinks that remain valid after the directory tree is moved or mounted at a different location:

```yaml
files:
  configs/active:
    src: configs/production.yml
    symlink: relative # symlink points to production.yml rather than an absolute path
```

**How `diff` and `pull` handle symlinks:**

- No symlink at the target path → create it (shown as a new entry in the diff)
- Symlink already points to the correct target → no-op (no diff output, exit 0)
- Symlink points to a different target → update it (diff shows old → new target)
- A regular file exists at the target path → replace it with a symlink (shown in diff)

The symlink itself is tracked in avanti's history, so `revert` and `reset` restore the symlink (including its target path) to the state recorded at the referenced pull.

**Constraints** — `symlink` cannot be combined with:

- `replace`, `template`, `json`, `yaml`, `toml`, `ini`, `on.write`, `extract` — content processors are meaningless for a symlink
- `writeInPlace`, `strategy`, `followSymlink` — incompatible write strategies
- `mode` — symlinks do not have independent permission bits on POSIX
- A list `src` — a symlink has exactly one target
- `src.sha`, `src.filter`, `src.if`, `src.ifAny` — object-form src options that only apply to fetched content
- The `$self` key — the config file itself cannot be a symlink entry

**POSIX only** — symlink entries are not supported on Windows. `pull` will error if a symlink entry is reached on win32. Use an `if: { os: [linux, mac] }` condition to gate symlink entries in cross-platform configs.

### Sudo

Set `sudo: true` to write a file using elevated privileges (as root). Set `sudo: "username"` to write as a specific user via `sudo -u`:

```yaml
files:
  /etc/ssh/sshd_config:
    src:
      github:
        repo: org/system-configs
        file: sshd_config
    mode: '0600'
    sudo: true

  /var/www/html/index.html:
    src: https://example.com/index.html
    sudo: 'www-data'
```

Absolute target paths (e.g. `/etc/ssh/sshd_config`) require `--working-dir /`. The map key is the target path:

```sh
avanti pull --working-dir /
```

avanti opens a single privileged worker session per distinct sudo identity — a persistent `sudo node dist/privileged-worker.js` process that handles all file operations for that identity in one batch. The session is opened **after** the user has reviewed the diff and confirmed the operation, so the sudo password prompt always appears after `Apply changes? [y/N]`, never before. Unreadable targets (e.g. files owned by root with mode `0600`) are shown as `(unreadable)` in the diff before confirmation; avanti reads their actual content for a precise diff after the session opens. Multiple files sharing the same sudo identity share one session — no matter how many files are written, avanti asks for the sudo password at most once per identity.

**Stale-file cleanup** — when a `sudo` entry is removed from the config, avanti uses the stored sudo identity to restore or delete the file during the next pull.

**POSIX only** — `pull` errors on Windows when any file has `sudo` set. Use an `if: { os: [linux, mac] }` condition to gate `sudo` entries in cross-platform configs.

#### Node.js binary requirement

The privileged worker runs as a separate Node.js process launched via `sudo`. avanti looks for a root-owned Node.js ≥18 binary in standard system paths (`/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` on macOS, `/bin`). User-managed installs (nvm, fnm, mise) under `$HOME` are not usable because the sudo target cannot traverse the calling user's home directory.

On **NixOS, Guix, and other non-FHS distros** where no root-owned system Node is in those paths, set `AVANTI_NODE_EXEC` to the absolute path of a compatible binary before running avanti:

```sh
AVANTI_NODE_EXEC=$(readlink -f $(which node)) avanti pull
```

avanti emits a warning when `AVANTI_NODE_EXEC` is set, since it bypasses the root-ownership security check on the binary passed to `sudo`. Only set it when the binary path is trusted.

**Limitations:**

- `sudo` is honored by `pull` only. The `revert` and `reset` commands use normal file operations and will fail on root-owned paths.
- `strategy: insert` cannot be combined with `sudo` — insert mode reads the existing file without privilege escalation, which silently treats an unreadable privileged file as absent. avanti rejects this combination at config parse time.
- `backup` paths for `sudo` entries are resolved before privilege escalation. The backup path's parent directories must be stat-able by the current user (all ancestor directories need the execute/search bit set). A 0755 root-owned backup directory works fine; a 0700 root-owned directory does not, because `lstat` cannot traverse it to resolve `%d` counters or verify the path.

### Variables

Define reusable values at the top level under `variables:`:

```yaml
variables:
  email: you@example.com
  version: '1.2.3'
```

Reference them anywhere in the config with `$name`:

```yaml
files:
  renovate.json:
    src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: $version # resolved to "1.2.3"
    replace:
      - from: '{EMAIL}'
        to: $email # resolved to "you@example.com"
```

Variables are resolved in every string field: target keys, `ref`, `exec` commands, HTTP URLs, local paths, `raw` content, `filter` patterns, `replace` rules (`from` and `to`), and `on.write` scripts. Side-effect hooks (`on.beforeWrite`, `on.beforeCreate`, `on.beforeUpdate`, `on.create`, `on.update`) are passed to the shell verbatim — use `$AVANTI_TARGET` / `$AVANTI_IS_NEW` env vars instead of `$varname` substitutions.

For `raw:` sources, variables are resolved in the content itself. For all other source types (`http`, `local`, `github`, `gitlab`, `exec`), variables are only resolved in the fields that locate the source (URL, path, command) — not in the fetched content. Use a `replace:` rule if you need to substitute values in fetched content.

**Shell safety in `exec:` and `on.write`** — when a variable is substituted into an `exec:` command or an `on.write` hook script, its value is automatically single-quoted. This means shell metacharacters (`;`, `&&`, `$(...)`, etc.) in the value are treated as literal data and are never executed. The surrounding command template itself is not quoted, so the static shell syntax you write is executed as usual. On Unix the script runs via `sh -c`; on Windows it runs via PowerShell (`-EncodedCommand`).

```yaml
variables:
  version: '1.0'

files:
  data.json:
    src:
      exec: curl https://example.com/api/$version/data # expands to: curl …/'1.0'/data
    on:
      write: sed 's/$version/replaced/g' # expands to: sed 's/'\''1.0'\''/replaced/g'
```

**Escaping a literal `$`** — use `$$` to emit a literal `$` that is not treated as a variable reference. This is useful in `exec:` commands and `on.write` hook scripts that contain shell or PowerShell syntax with `$`-prefixed identifiers (e.g. PowerShell built-ins like `$$true` or `$$null`):

```yaml
files:
  out.txt:
    src:
      # On Windows exec: runs in PowerShell — $true is a PS built-in, needs $$
      exec: "if ($$true) { Write-Output 'yes' }"
    on:
      write: sed 's/$$HOME/redacted/g' # $HOME would be treated as an avanti variable
```

`$$` produces a single `$` after substitution. `$$$name` produces `$` followed by the value of `name`. `$${expr}` produces a literal `${expr}` — use this to include shell-style `${VAR}` or template placeholders verbatim in a string without avanti interpreting them.

#### List and object variables

Variables can hold lists (arrays) and objects (dictionaries), including nested structures. Declare them using standard YAML syntax:

```yaml
variables:
  # list variable
  envs:
    - staging
    - production

  # object variable
  db:
    host: postgres.internal
    port: 5432
    creds:
      user: admin
```

Any `$var` references inside string leaves are resolved against previously defined variables, just like plain string variables.

> **Note:** `src` is a reserved key name at the top level of an object variable. An object whose top-level key is `src` is interpreted as a source-backed variable (fetched from a URL, file, `exec:`, etc.), not as a plain data object. If you need to pass an object that has a `src` property, nest it one level deeper (e.g. `data: {src: "..."}`).

#### Accessing nested values with `${expr}`

Use the braced `${expr}` syntax to access a specific element from a list or object variable in any string field. The expression supports dot notation for object properties, bracket notation for array indices, and combinations of both:

| Syntax            | Description                             | Example result                     |
| ----------------- | --------------------------------------- | ---------------------------------- |
| `$name`           | Variable value (stringified if complex) | `$version` → `1.2.3`               |
| `${name}`         | Braced form of the above                | `${version}` → `1.2.3`             |
| `${name.prop}`    | Object property access                  | `${db.host}` → `postgres.internal` |
| `${name[n]}`      | Array index access (zero-based)         | `${envs[0]}` → `staging`           |
| `${name[n].prop}` | Array element property                  | `${servers[1].host}` → `web2`      |
| `${name.a.b.c}`   | Deeply nested property                  | `${db.creds.user}` → `admin`       |

When a leaf value is a number or boolean it is coerced to a string. When the expression resolves to an object or array it is JSON-serialised. Using a plain `$name` reference where `name` holds a list or object also JSON-serialises the value.

> **Identifier restriction:** Variable names and dot-accessed property keys must be valid identifiers (`[A-Za-z_][A-Za-z0-9_]*`). Object keys containing hyphens, spaces, or other special characters (e.g. `my-key`) cannot be accessed via `${expr}`. Use a template engine if you need to reference such keys.
>
> **Note:** Any `${...}` in a config string is now parsed as a path expression. Shell-style expansions such as `${HOME:-/tmp}` or external template placeholders like `${MY_VAR}` must be escaped as `$${HOME:-/tmp}` / `$${MY_VAR}` to be passed through literally.

```yaml
variables:
  envs:
    - staging
    - production
  db:
    host: postgres.internal
    port: 5432
    creds:
      user: admin

  # derive further string variables from complex ones
  primary_env: ${envs[0]} # → "staging"
  db_host: ${db.host} # → "postgres.internal"
  db_user: ${db.creds.user} # → "admin"

files:
  deploy.sh:
    src:
      raw: 'psql -h ${db.host} -p ${db.port} -U ${db.creds.user}'
```

When using a [template engine](#template-rendering), the full list or object is passed as context and all native template features — loops, conditionals, filters — work on them directly. The `${expr}` syntax is only needed for plain string interpolation outside of templates.

**Environment variables** use the `$env:NAME` form:

```yaml
replace:
  - from: /secret-token/
    to: $env:MY_SECRET # reads process.env.MY_SECRET at runtime
```

Referencing an undefined variable or a missing environment variable is an error.

#### Source-based variables

A variable can be populated from any remote or local source — the same source types supported by `files:`. Instead of a plain string value, provide a `src:` key:

```yaml
variables:
  auth_token:
    src:
      aws_secrets_manager:
        name: my-artifactory-token
  registry_host: my-registry.example.com

files:
  .npmrc:
    src:
      raw: |
        registry=https://$registry_host
        //$registry_host/:_authToken=$auth_token
```

The fetched content is trimmed of leading and trailing whitespace before being used as the variable value (secrets from AWS Secrets Manager, SSM Parameter Store, Vault, etc. often include a trailing newline).

All source types are supported: `http`, `path`, `url`, `exec`, `github`, `gitlab`, `bitbucket`, `git`, `aws_s3`, `aws_secrets_manager`, `aws_systems_manager_parameter`, `vault`, and `raw`. Multi-source arrays and `json`/`yaml`/`toml` merging work exactly as they do in `files:`:

```yaml
variables:
  config:
    src:
      - raw: '{"base":"value"}'
      - raw: '{"extra":"added"}'
    json:
      conflicts: last_wins
```

**Evaluation order** — variables are resolved one by one in the order they are defined. A variable may reference any variable defined above it. Referencing a variable that has not yet been defined (a forward reference) is an error. This rule also prevents circular dependencies.

```yaml
variables:
  host: registry.example.com
  token:
    src:
      aws_secrets_manager:
        name: my-token # fetched first; $host is already resolved
  registry_line: //$host/:_authToken=$token # both $host and $token are available
```

The `ref` (and `release`) field accepts four forms:

- **Literal** — a branch name, tag, or commit hash passed directly to the VCS (e.g. `main`, `v1.2.3`, `abc123`).
- **`$latest`** — resolves to the newest **stable semver tag** (`vX.Y.Z` or `X.Y.Z`, no pre-release suffix), consistently across all providers. GitHub first checks the published "latest release" and accepts it when it is semver; all providers scan tags filtered by the semver pattern.
- **`$recent`** — resolves to the most **recently created or published tag**, regardless of its name format. Use this when you want whatever was tagged last, even if it is a nightly or pre-release build. For `git:` remotes the ordering is determined by `git ls-remote` output rather than creation date (date-based ordering requires fetching tag objects and is not supported).
- **`/pattern/[flags]`** — a regex pattern of the form `/body/` or `/body/flags` (e.g. `ref: /^v1\.\d+\.\d+$/`). Resolves to the first tag whose name matches the pattern, ordered newest-first on GitHub, GitLab, and Bitbucket. For `git:` remotes the match order follows `git ls-remote` output. Flags such as `i` are supported. Note: the pattern body must be non-empty — `//` is treated as a literal ref, not a match-all regex. The stateful flags `g` and `y` are silently stripped; any other unrecognised flag produces an error.

| Form           | Meaning                                          |
| -------------- | ------------------------------------------------ |
| `ref: $latest` | Newest `vX.Y.Z` / `X.Y.Z` stable tag             |
| `ref: $recent` | Most recently created/published tag (any format) |
| `ref: /^v1\./` | Latest tag matching the regex                    |
| `ref: main`    | Literal branch / tag / commit                    |

`$latest`, `$recent`, and `$self` are reserved and cannot be used as variable names.

When `ref` is omitted, all source types (GitHub, GitLab, Bitbucket, git) resolve to the repository's default branch.

`$self` is a reserved keyword that expands to the absolute path of the active config file. It is injected automatically and cannot be used as a variable name. Use it anywhere a variable is valid — `exec:` commands, `replace:` rules, `exists:` conditions, `on.write` scripts, or any source field:

```yaml
files:
  ./output.txt:
    src:
      raw: 'generated from: PLACEHOLDER'
    replace:
      - from: PLACEHOLDER
        to: $self # expands to e.g. /home/user/project/.avanti.yml

  ./copy-of-config.yml:
    src:
      exec: cat $self # reads the config file itself

  ./guarded.txt:
    src:
      raw: 'only written when config exists'
    if:
      exists: $self
```

When the config is specified as a remote spec (e.g. `--config github:org/repo:.avanti.yml`), `$self` expands to that spec string. In an `exists:` condition this will always evaluate to false since the remote spec is not a local path.

#### System-injected variables

In addition to `$self` and `$latest`, avanti injects several variables automatically at the start of every run. These names are reserved and cannot be used in `variables:`.

**Per-file path variables**, **pull-time variables**, and **system variables** are all available everywhere variables are resolved: source URLs, `ref:`, conditions, `replace:`, `on.write` scripts, template rendering, and `backup:` patterns. Side-effect hooks (`on.beforeWrite`, `on.beforeCreate`, `on.beforeUpdate`, `on.create`, `on.update`) do not resolve avanti variables — use `$AVANTI_TARGET` and `$AVANTI_IS_NEW` env vars instead.

**Per-file path variables** — avanti derives the following variables from each file entry's resolved target path.

Example with working directory `/home/user/project` and map key `configs/app.yaml`:

| Variable    | Value                                 |
| ----------- | ------------------------------------- |
| `$path`     | `/home/user/project/configs/app.yaml` |
| `$filename` | `app.yaml`                            |
| `$basename` | `app`                                 |
| `$ext`      | `yaml` (no leading dot)               |
| `$dirname`  | `/home/user/project/configs`          |
| `$basedir`  | `configs`                             |

> **Availability in source URLs and conditions:** per-file path variables are only resolved before the fetch when the map key is a fixed (non-directory) path. They are always available in processors (`replace:`, `on.write` scripts, template rendering) and `backup:`. Side-effect hooks (`on.create`, `on.update`, etc.) do not resolve avanti variables.

```yaml
variables:
  env: production

files:
  # $filename in source URL — fetches each file by its own target name
  configs/nginx.conf:
    src: github:org/config-store/$env/$filename # → …/production/nginx.conf

  # $basename strips the extension — useful when the remote has no extension
  services/auth.yaml:
    src: https://config-api.example.com/v1/$basename # → …/v1/auth

  # $path in a condition — only overwrite if the local file already exists
  generated/report.json:
    src:
      exec: generate-report.sh
    if:
      exists: $path

  # $dirname in on.write — transform content using the file's directory name
  app/config.yaml:
    src: github:org/repo/app/config.yaml
    on:
      write: sed "s|__DIR__|$dirname|g"
```

**Pull-time variables** — injected once at the start of every run and available everywhere (source URLs, conditions, `replace:`, `on.write` scripts, template rendering, `backup:`):

| Variable      | Value                                   | Example               |
| ------------- | --------------------------------------- | --------------------- |
| `$date`       | Current date `YYYY-MM-DD`               | `2026-05-20`          |
| `$datetime`   | Current date+time `YYYY-MM-DD-HH-mm-ss` | `2026-05-20-14-30-00` |
| `$workingDir` | The resolved working directory          | `/home/user/project`  |

`$workingDir` is useful to force a specific source to resolve against the working directory instead of the config file's location — e.g. `src: { path: $workingDir/local-only-file.txt }` — see [Working Directory](#working-directory).

```yaml
files:
  # Fetch today's report by date
  reports/daily.json:
    src: https://reports.example.com/$date/summary.json

  # Stamp the pull time into fetched content
  version.txt:
    src: github:org/repo/version.txt
    replace:
      - from: GENERATED_AT
        to: $datetime
```

**System variables** — injected once per run and reflect the machine running avanti. Useful for downloading the correct release artifact for the current OS and CPU architecture:

| Variable | `linux` | `darwin` | `win32`   |
| -------- | ------- | -------- | --------- |
| `$os`    | `linux` | `darwin` | `windows` |

| Variable   | `x64`    | `arm64` | `ia32` | `arm` |
| ---------- | -------- | ------- | ------ | ----- |
| `$arch`    | `x86_64` | `arm64` | `i686` | `arm` |
| `$arch_go` | `amd64`  | `arm64` | `386`  | `arm` |

`$arch` uses GNU-triple / Rust naming (`x86_64`). `$arch_go` uses Go / Docker / Kubernetes naming (`amd64`). The `arm64` value is identical in both. Unknown `process.platform` or `process.arch` values are passed through unchanged.

```yaml
variables:
  rg_version: '14.1.1'
  kubectl_version: '1.32.0'

files:
  # Download the ripgrep tarball for the current system (Rust/GNU naming)
  releases/ripgrep.tar.gz:
    src: https://github.com/BurntSushi/ripgrep/releases/download/$rg_version/ripgrep-$rg_version-$arch-unknown-$os.tar.gz

  # Download kubectl for the current system (Go naming)
  bin/kubectl:
    src: https://dl.k8s.io/release/v$kubectl_version/bin/$os/$arch_go/kubectl
```

### $self — Self-managing Config

The special `$self` key in the `files:` map tells avanti to manage its own config file. When `$self` is present, avanti fetches the listed sources and uses the result as the active config for the rest of the run — all in a single invocation.

```yaml
files:
  $self:
    src:
      github:
        repo: myorg/dotfiles
        file: avanti.yml
        ref: $latest
```

**How it works:**

1. avanti fetches only the `$self` sources first.
2. The sources are assembled into a single document. With a single source the fetched content is used directly, though it may be normalized/formatted if `yaml:`/`json:` applies (explicit or auto-detected from the file extension). With multiple sources they are concatenated by default, or YAML/JSON-merged if `yaml:`/`json:` is set (or auto-detected from all source file extensions being `.yml`/`.yaml` or `.json`/`.jsonc`).
3. The result is parsed as the new active config. If it also contains `$self`, avanti re-fetches until the content stabilizes (fixed point).
4. The stable config drives all remaining file entries. On `avanti pull`, the stable content is written back to the local config file (for local configs) or kept in memory only (for remote `--config` sources). On `avanti diff`, the stable config is used in-memory to compute the diff and is never written.

**Multi-layer config** — list multiple sources under `$self` and use `yaml:` to deep-merge them into one config:

```yaml
files:
  $self:
    src:
      - github:
          repo: myorg/platform
          file: avanti/base.yml
          ref: $latest
      - github:
          repo: myorg/backend-team
          file: avanti/team.yml
          ref: main
      - path: ~/avanti-personal.yml
        optional: true
    yaml:
      conflicts: last_wins
      arrays: concat
```

`$self` supports all the same source types, `replace`, `on.write`, and YAML/JSON merge options as any other file entry. Lifecycle hooks (`on.beforeWrite`, `on.beforeCreate`, `on.beforeUpdate`, `on.create`, `on.update`) are not supported for `$self` — they require a confirmed write context that the config re-evaluation pass does not have. See [Self-managing Config](#self-managing-config) in the Use Cases section for a full worked example.

### Authentication

Public repositories on github.com and gitlab.com work without any configuration. For private repositories or instances, supply credentials via environment variables:

| Platform        | Environment variable(s)                                          | Notes                                      |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| GitHub          | `GITHUB_TOKEN`                                                   | `Authorization: Bearer <token>`            |
| GitLab          | `GITLAB_TOKEN` or `GITLAB_PRIVATE_TOKEN`                         | `PRIVATE-TOKEN: <token>`                   |
| Bitbucket       | `BITBUCKET_EMAIL` + `BITBUCKET_TOKEN`                            | Basic auth (Atlassian API token)           |
| Bitbucket       | `BITBUCKET_TOKEN`                                                | Bearer auth (workspace/repo access token)  |
| S3              | Standard AWS env vars (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, etc.) | AWS SDK credential chain                   |
| Secrets Manager | Standard AWS env vars (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, etc.) | AWS SDK credential chain                   |
| SSM             | Standard AWS env vars (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, etc.) | AWS SDK credential chain                   |
| Vault           | `VAULT_TOKEN` + `VAULT_ADDR` (and optionally `VAULT_NAMESPACE`)  | Used when the `vault` CLI is not installed |

If a GitHub or GitLab request fails with a 401, 403, or 404 response, or with a network-level connectivity error, and `gh` / `glab` is installed and authenticated, the tool falls back to the CLI automatically. This means existing CLI setups continue to work for private repos without any extra configuration.

Use the `via` field on a source to control which transport is tried and in what order:

- `via: cli` — CLI only; the HTTP API is never called. Eliminates timeout waits on machines where the API is unreachable.
- `via: api` — HTTP API only; no CLI fallback even on network errors.
- `via: [cli, api]` — CLI first; falls back to the HTTP API if the CLI fails for any reason.
- `via: [api, cli]` — equivalent to the default; HTTP API first, falls back to the CLI on connectivity failures and auth/access errors (401/403/404).

HTTP server errors (5xx) do not trigger CLI fallback regardless of the `via` order, because the CLI hits the same API endpoint and encounters the same error. By the time a 5xx surfaces here, `fetchWithRetry` has already retried it with exponential backoff.

**Vault** uses the `vault` CLI when it is installed (picks up `VAULT_TOKEN`, `~/.vault-token`, and any other auth methods configured in the CLI). If the CLI is not available, it falls back to the HTTP API using `VAULT_ADDR` and `VAULT_TOKEN`.

**S3, Secrets Manager, and SSM** use the AWS SDK default credential chain (env
vars, `~/.aws/credentials`, instance profiles, etc.).

### Private Instances

Set the `host` field directly on a source to target a private instance.
This is the preferred approach when different sources in the same config
point to different hosts:

```yaml
src:
  gitlab:
    project: group/repo
    file: path/to/file.txt
    host: gitlab.mycompany.com   # private GitLab instance

src:
  github:
    repo: owner/repo
    file: path/to/file.txt
    host: github.mycompany.com   # GitHub Enterprise Server
```

Alternatively, set an environment variable to apply a host override globally
for all sources of that type (useful when every source in the config targets
the same private instance):

**GitLab** — set `GITLAB_HOST` to override the default `gitlab.com`:

```bash
GITLAB_HOST=gitlab.mycompany.com avanti pull
```

**GitHub Enterprise Server** — set `GITHUB_HOST` to override the default
`github.com` (API requests go to `https://{GITHUB_HOST}/api/v3`):

```bash
GITHUB_HOST=github.mycompany.com avanti pull
```

**Bitbucket** — set `BITBUCKET_HOST` to override the default
`api.bitbucket.org` (Bitbucket Cloud REST API host):

```bash
BITBUCKET_HOST=bitbucket.mycompany.com avanti pull
```

A `host` field on a source always takes precedence over the corresponding
environment variable.

## Use Cases

### Composable AI Agent Instructions (CLAUDE.md / AGENTS.md)

Assemble agent instruction files from multiple sources: a static header defined inline, team-specific rules from a shared GitLab repo, and company-wide standards from GitHub — all merged into one file. Every developer runs `avanti pull` and stays in sync without copy-paste drift across dozens of repos.

```yaml
# .avanti.yml
variables:
  team: backend
  jira_project: BE
  oncall_channel: '#backend-oncall'

files:
  CLAUDE.md:
    src:
      - raw: |
          # AI Assistant Guidelines
          <!-- THIS FILE IS MANAGED — run `avanti pull` to update -->
      - gitlab:
          project: platform/ai-standards
          file: teams/backend-rules.md
          ref: main
      - github:
          repo: org/shared-prompts
          file: company-standards.md
          ref: main
      - raw: |
          ## Team Context
          Team: $team
          Jira project: $jira_project
          Oncall: $oncall_channel
      - path: ~/custom-claude.md # personal additions; silently skipped if absent
        optional: true
```

The `optional: true` source is the key to sharing a config across a whole team: the central spec references a well-known local path, and each developer either creates the file to add their own context or ignores it — `avanti pull` works either way. No per-person fork of the config needed.

### Shared Tooling Config (Renovate, ESLint, Prettier, TSConfig)

A platform team owns canonical configs in a central repo. Projects pull them and stay current. Pin all files to the same version in one place — bump `standards_ref` and `avanti diff` shows every file that will change before you apply it.

```yaml
variables:
  standards_ref: v2.4.1

files:
  renovate.json:
    src:
      github:
        repo: org/standards
        file: renovate.json
        ref: $standards_ref

  eslint.config.js:
    src:
      github:
        repo: org/standards
        file: eslint.config.js
        ref: $standards_ref

  tsconfig.base.json:
    src:
      github:
        repo: org/standards
        file: tsconfig.base.json
        ref: $standards_ref
```

For YAML-based configs (Helm values, k8s manifests, Docker Compose overrides), use YAML merge to layer a shared base with project-specific values. Comments in both files are preserved in the merged output:

```yaml
files:
  ./helm/merged-values.yaml:
    src:
      - github:
          repo: org/platform
          file: helm/base-values.yaml # shared defaults for all services
          ref: $standards_ref
      - ./helm/values.yaml # project overrides
    yaml:
      conflicts: last_wins # project overrides win
      arrays: concat # e.g. extra env vars are appended, not replaced
```

### CI/CD: Shared Workflow Fragments

Pull reusable CI steps from a central repo into each project. A managed header makes it obvious the file should not be edited by hand.

```yaml
files:
  .github/workflows/security-scan.yml:
    src:
      - raw: |
          # THIS FILE IS MANAGED — run `avanti pull` to update
      - github:
          repo: org/ci-templates
          file: workflows/security-scan.yml
          ref: main
```

Use `avanti diff` in CI to detect drift — if a project's checked-in file no longer matches the source, the pipeline fails.

### CI/CD: Scheduled Sync PR

Instead of pulling during deployment, run avanti on a schedule. If anything changed upstream, open a pull request automatically. Teams review and merge at their own pace — no surprise updates mid-deploy.

```yaml
# .github/workflows/avanti-sync.yml
name: Sync shared configs

on:
  schedule:
    - cron: '0 8 * * 1' # every Monday at 08:00
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install avanti
        run: npm install -g @udondan/avanti

      - name: Check for upstream changes
        id: diff
        run: |
          avanti diff && echo "changed=false" >> "$GITHUB_OUTPUT" \
            || echo "changed=true" >> "$GITHUB_OUTPUT"

      - name: Apply changes
        if: steps.diff.outputs.changed == 'true'
        run: avanti pull --yes

      - name: Open pull request
        if: steps.diff.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          branch: avanti/sync
          commit-message: 'chore: sync shared configs via avanti'
          title: 'chore: sync shared configs'
          body: |
            Upstream sources changed. Review the diff and merge to apply.

            Generated by the weekly avanti sync job.
```

`avanti diff` exits `1` when changes are detected and `0` when everything is already in sync, so the job skips the PR step entirely when there is nothing to update.

### Environment-Specific Config from a Single Spec

One config file adapts to any environment via variables and env vars. No duplicate specs, no templating hacks.

```yaml
variables:
  region: eu-west-1

files:
  k8s/deployment.yaml:
    src:
      github:
        repo: org/infra
        file: k8s/deployment-template.yaml
        ref: $env:DEPLOY_VERSION
    replace:
      - from: '{ENV}'
        to: $env:ENVIRONMENT
      - from: '{REGION}'
        to: $region
```

CI sets `DEPLOY_VERSION` and `ENVIRONMENT`; the config pins every file to exactly the version being deployed.

### Secrets from Vault or AWS

Pull secrets at runtime and write them to local files with tight permissions.
The native `vault:` source authenticates via the Vault CLI or `VAULT_TOKEN` env
var. The `aws_s3:`, `aws_secrets_manager:`, and `aws_systems_manager_parameter:`
sources authenticate via the AWS SDK credential chain (env vars, `~/.aws/credentials`,
IAM roles). No shell scripting needed.

```yaml
files:
  # Single field from a Vault KV secret
  config/db_password.txt:
    src:
      vault:
        path: secret/myapp/db
        field: password
    mode: '0600'

  # Full Vault secret as JSON
  config/secrets.json:
    src:
      vault:
        path: secret/myapp/config
    mode: '0600'

  # Config file stored in S3
  config/app.json:
    src:
      aws_s3: s3://my-bucket/configs/app.json
    mode: '0600'
```

For AWS SSM or other secret stores without a dedicated source type, `exec:` still works:

```yaml
files:
  config/db.json:
    src:
      exec: >
        aws ssm get-parameter
        --name /myapp/db-config
        --with-decryption
        --query Parameter.Value --output text
    mode: '0600'
```

### Multi-Project Deployment

Pair a shared config with `-w` to stamp files across many service directories without duplicating the spec:

```sh
for dir in services/*/; do
  avanti -c shared/avanti.yml -w "$dir" pull --yes
done
```

### Docker Compose from Upstream Sources

Many open source projects ship example `docker-compose.yml` files. Pull them directly from their repos, merge them into a single file, and use `replace` rules to substitute placeholder values — no forking, no copy-paste, no drift.

This example assembles a self-hosted [n8n](https://github.com/n8n-io/n8n-hosting/blob/main/docker-caddy/docker-compose.yml) workflow automation stack: n8n and Caddy as the reverse proxy, backed by [Postgres](https://github.com/docker-library/docs/blob/master/postgres/compose.yaml).

```yaml
variables:
  n8n_version: 1.94.1
  domain: n8n.example.com
  db_password: changeme

files:
  docker-compose.yml:
    src:
      - github:
          repo: n8n-io/n8n-hosting
          file: docker-caddy/docker-compose.yml
          ref: main
      - github:
          repo: docker-library/docs
          file: postgres/compose.yaml
          ref: master
    replace:
      - from: '${N8N_VERSION}'
        to: $n8n_version # pin version at pull time
      - from: '${SUBDOMAIN}.${DOMAIN_NAME}'
        to: $domain # flatten two-part domain into one value
      - from: 'POSTGRES_PASSWORD: example'
        to: 'POSTGRES_PASSWORD: $db_password'
    yaml:
      conflicts: last_wins
      arrays: concat # environment lists are appended, not replaced
```

YAML merge combines both files' `services` blocks into a single `docker-compose.yml`. The `replace` rules fix the postgres placeholder password and bake in your domain and version before the file is written. The remaining `${...}` placeholders in the n8n compose (`DATA_FOLDER`, `GENERIC_TIMEZONE`, `RUNNERS_AUTH_TOKEN`) are resolved by Docker Compose itself at runtime from a `.env` file, so they pass through unchanged.

Run `avanti pull` whenever either upstream file updates — your customizations stay in the config, not in a fork.

### Developer Onboarding Bootstrap

A single `avanti pull` populates a new project with everything it needs: editor config, CI workflows, linting rules, AI instructions — all from blessed central sources, all up to date.

```yaml
files:
  .editorconfig:
    src:
      github:
        repo: org/standards
        file: .editorconfig
        ref: main

  .prettierrc:
    src:
      github:
        repo: org/standards
        file: .prettierrc
        ref: main

  CLAUDE.md:
    src:
      - raw: |
          # AI Assistant Guidelines
          <!-- THIS FILE IS MANAGED — run `avanti pull` to update -->
      - github:
          repo: org/ai-standards
          file: CLAUDE.md
          ref: main

  .github/workflows/:
    src:
      github:
        repo: org/ci-templates
        file: workflows/
        ref: main
```

### Scaffold Defaults with Local Overrides

Ship default config files that users can customize, and automatically compose downstream files from those customized versions — all in a single `avanti pull`.

```yaml
files:
  # Created once on first run. The user edits this to set their preferences.
  ./config/prettier.json:
    src:
      raw: |
        {
          "singleQuote": true,
          "semi": false
        }
    if:
      target_exists: false

  # Always rebuilt. Sources org defaults from GitHub, then merges in local overrides.
  ./.prettierrc.json:
    src:
      - github:
          repo: org/standards
          file: prettier-base.json
          ref: main
      - path: ./config/prettier.json
    json:
      conflicts: last_wins
      objects: merge
```

On first run both files are created: `config/prettier.json` gets the default template, `.prettierrc.json` merges the org base with those defaults. The user then edits `config/prettier.json` to suit their preferences. On every subsequent run, `.prettierrc.json` is rebuilt from the org base plus whatever the user has in their local override file — and `config/prettier.json` is left untouched.

### Self-managing Config

avanti can manage any file — including its own config. The special `$self` key in the `files:` map fetches and merges one or more sources, uses the result as the active config, and then applies all the files it declares — in the same run, with a single confirmation prompt.

```yaml
# ~/.avanti.yml
files:
  $self:
    src:
      github:
        repo: myorg/dotfiles
        file: avanti.yml
        ref: $latest
```

Every `avanti pull` fetches the remote `avanti.yml`, applies all the files it declares, and writes the merged result back to `~/.avanti.yml`. If the remote `avanti.yml` itself contains a `$self` entry, avanti keeps re-fetching until the content stabilizes — so the remote config can keep pointing at itself and avanti will always pick up the latest version on every pull.

When running with a remote config (`--config github:...`), `$self` is in-memory only — the merged result drives the run but is not persisted anywhere, since there is no local file to write back to.

**Composable config** — `$self` with multiple sources and YAML merge lets you assemble a config from independent layers. Org-wide defaults, team additions, and personal overrides all merge into one active config:

```yaml
# ~/.avanti.yml
files:
  $self:
    src:
      - github:
          repo: myorg/platform
          file: avanti/base.yml # org-wide entries and variables
          ref: $latest
      - github:
          repo: myorg/backend-team
          file: avanti/team.yml # team-specific additions
          ref: main
      - github:
          repo: myuser/dotfiles
          file: avanti/personal.yml # personal overrides and extras
          ref: main
    yaml:
      conflicts: last_wins # personal overrides win over team, team over org
      arrays: concat # file lists from all layers are merged, not replaced
```

Each layer only needs to declare what it owns. The org config defines shared tooling. The team config adds team-specific sources. The personal config overrides variables or adds private entries. Every `avanti pull` rebuilds the merged config and applies all the files it describes — org-wide config drift and personal customisation coexist without conflict.

For first-time setup on a new machine, pass a remote config directly to `--config` — no local file needed:

```sh
# From a GitHub repo
avanti pull -c github:myorg/dotfiles:avanti.yml

# Pinned to a specific ref
avanti pull -c github:myorg/dotfiles:avanti.yml@v2.1.0

# From a GitLab project (nested groups supported)
avanti pull -c gitlab:myorg/infra/dotfiles:avanti.yml@main

# Or a plain HTTPS URL
avanti pull -c https://configs.example.com/bootstrap.yml

# From a private git repo over SSH (double-slash separates repo from file path)
avanti pull -c git+ssh://git@ssh.git.private.de/org/repo.git//avanti.yml
avanti pull -c git+ssh://git@ssh.git.private.de/org/repo.git//avanti.yml@main
```

The `github:` and `gitlab:` config formats use the `gh`/`glab` CLI (with their
token auth and fallback) to fetch the file — no extra setup needed for repos
those tools can already access.

For any other git remote, use
`git+ssh://git@host/org/repo.git//path/to/file.yml[@ref]` (or `git://` /
`ssh://`). The `//` separator splits the repo URL from the file path inside the
repo; `@ref` pins to a branch, tag, or commit. This form runs `git clone`
directly, so authentication uses your SSH agent, `~/.ssh/config`, or any
credential helper configured for that host.

This scales to any number of machines or containers. Update the central repo once; every client picks up the change on its next pull. No config drift, no manual distribution.

## Exit Codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | Success / no changes            |
| `1`  | Changes detected (diff command) |
| `2`  | Error                           |

## Development

```sh
git clone ...
mise run install            # install dependencies and set up git hooks
mise run dev -- --help      # run via tsx
mise run test               # run tests
mise run build              # compile to dist/
```
