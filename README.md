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
- **`src` paths** (plain string, for fetching content) — resolved relative to the **config file's location**. If the config is a local file, relative sources resolve relative to its directory. If the config is remote (GitHub, GitLab, HTTPS, `git+ssh://`), relative plain-string sources resolve to the same remote location. **Exception:** when `symlink:` is set, `src` is the symlink target path (always a local filesystem path) and resolves against the working directory — it is never config-relative. `path:` object sources also always resolve relative to the working directory.

This means a config at `./configs/avanti.yml` can use `src: ./templates/foo.sh` to reference `./configs/templates/foo.sh`, regardless of what working directory you pass with `-w`.

For remote configs, relative source paths are resolved within the same remote context:

```yaml
# config loaded from github:owner/repo:configs/avanti.yml
files:
  dist/script.sh:
    src: ./scripts/build.sh # fetches github:owner/repo:configs/scripts/build.sh
```

The `path:` object source always refers to the local filesystem and its relative paths resolve against the working directory, regardless of whether the config file is local or remote.

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
