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
- [History](#history)
  - [`avanti log`](#avanti-log)
  - [`avanti diff <pullId>`](#avanti-diff-pullid)
  - [`avanti revert [pullId]`](#avanti-revert-pullid)
  - [`avanti reset`](#avanti-reset)
  - [`--verbose` / `-v`](#--verbose---v)
- [Working Directory](#working-directory)
  - [Path Constraints](#path-constraints)
- [Configuration](#configuration)
  - [File Entry Fields](#file-entry-fields)
  - [Source Types](#source-types)
  - [Directory Sources](#directory-sources)
  - [JSON Merging](#json-merging)
  - [YAML Merging](#yaml-merging)
  - [TOML Merging](#toml-merging)
  - [Template Rendering](#template-rendering)
  - [Insert Mode](#insert-mode)
  - [Conditions](#conditions)
  - [Scaffold Pattern](#scaffold-pattern)
  - [Backup](#backup)
  - [Variables](#variables)
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
- **Variables** — define reusable values in a `variables:` block and reference them anywhere with `$name`; variables can be plain strings, `$env:NAME` environment variable references, or fetched from any remote/local source (the same source types as `files:`)
- **Post-processing** — apply text replacements (string or regex) and/or pipe content through a shell script
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

SHA is computed over the raw fetched content of each source, before any `replace` or `post` processing. Each file's path and content are fed into the hash in sorted order, separated by null bytes — so renames and additions affect the fingerprint even for single-file sources. Pull history records the observed SHA for every source, so `avanti log` shows a full audit trail of what changed and when.

Excluded from SHA pinning: local paths and `raw:` sources (their content is either authored locally or inline in the config, so changes are always visible).

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
- CLI tool invocations (`gh`, `glab`, `aws`, `vault`, `git`)
- Cache hits

**Credential safety:** tokens are read from environment variables and sent as HTTP headers, which are never logged. Git URLs with embedded credentials are redacted. `exec:` source commands are logged verbatim — if your config embeds secrets in an exec command (e.g. `exec: curl -H "Token: $env:MY_SECRET"`), those secrets will appear in verbose output after variable substitution.

## Working Directory

All relative `src` and `target` paths are resolved relative to the **working directory** — the directory where you invoke `avanti`, or the path given with `-w`.

This is independent of where the config file lives. A config loaded from another directory with `-c /shared/avanti.yml` still resolves all paths from your working directory (or the one you specify with `-w`).

Use `-w` to deploy the same config to multiple locations without `cd`-ing there first:

```sh
avanti -c /shared/avanti.yml -w /project-a pull
avanti -c /shared/avanti.yml -w /project-b pull
```

### Path Constraints

Avanti enforces that target paths cannot escape the working directory:

- **Relative targets** are resolved under the working directory. A path like `../../etc/passwd` is rejected.
- **Absolute targets** (e.g. `/etc/hosts`) are only permitted when the working directory is `/`. If your working directory is any other path, absolute targets are an error.

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
    post: sed -e 's/v3/v4/g'

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

| Field      | Required | Description                                                                                                                                                                                                                             |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`      | Yes      | Source (see below). May be a single source or a **list** of sources to concatenate.                                                                                                                                                     |
| `if`       | No       | Condition object (or list of objects). All must pass for the entry to be processed. See [Conditions](#conditions).                                                                                                                      |
| `ifAny`    | No       | List of condition objects. At least one must pass. See [Conditions](#conditions).                                                                                                                                                       |
| `mode`     | No       | File permission mode, e.g. `"0755"`                                                                                                                                                                                                     |
| `replace`  | No       | List of `{from, to}` replacement rules. `from` may be a plain string or `/pattern/flags` regex.                                                                                                                                         |
| `post`     | No       | Shell script. Content is piped via stdin; stdout is used as the result. Runs after `replace`.                                                                                                                                           |
| `template` | No       | Treat the fetched content as a template and render it with avanti config variables as context. See [Template Rendering](#template-rendering).                                                                                           |
| `json`     | No       | JSON merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.json` or `.jsonc` extension. Use `true`/`false` to force on or off regardless of extension.                                        |
| `yaml`     | No       | YAML merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.yaml` or `.yml` extension. Use `true`/`false` to force on or off regardless of extension. Comments are preserved in merged output. |
| `strategy` | No       | Write strategy: `replace` _(default)_ — overwrite the target file entirely; `insert` — merge content into the existing file without clobbering unrelated content. See [Insert Mode](#insert-mode).                                      |

### Source Types

**Plain string** — HTTP/HTTPS URL or local path:

```yaml
src: https://example.com/file.txt
src: ~/templates/file.txt
src: /absolute/path/file.txt
```

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
    file: path/to/file.txt       # file or directory in repo
    ref: main                    # branch, tag, or $latest (optional)
    sha: abc123...               # optional SHA-256 fingerprint
    host: gitlab.mycompany.com   # override default gitlab.com (optional)
    via: cli                     # api, cli, or list (default: [api, cli])

src:
  github:
    repo: owner/repo             # GitHub owner/repo
    file: path/to/file.txt       # file or directory in repo
    ref: main                    # branch, tag, or $latest (optional)
    sha: abc123...               # optional SHA-256 fingerprint
    host: github.mycompany.com   # GitHub Enterprise Server hostname (optional)
    via: cli                     # api, cli, or list (default: [api, cli])

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

Sources are fetched in order and joined with a newline. Post-processing (`replace`, `post`) is applied to the combined result. If any source fails, the entire entry is aborted.

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

### Template Rendering

Set `template` to treat the fetched content as a template. avanti renders it at deploy time using all avanti config variables as the template context, then writes the rendered output to the target file.

> **Security note** — EJS and Eta templates execute arbitrary JavaScript at render time. Handlebars, Nunjucks, Liquid, and Mustache are logic-limited and do not execute raw JS. For any engine, template sources must be trusted: either authored locally, fetched from a controlled internal source, or SHA-pinned (see [`sha:`](#sha-pinning)). Treat a compromised remote template as equivalent to a compromised `post:` script or `exec:` source.

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

**Pipeline order** — template rendering runs first, before `replace` and `post`. Subsequent processors receive the already-rendered content.

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
- **Subsequent runs (no-op)** — avanti detects that the raw source and the post-processed output (`replace`/`post`) are both unchanged and skips the file entirely.
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

| Field           | Type           | Description                                                                        |
| --------------- | -------------- | ---------------------------------------------------------------------------------- |
| `os`            | string or list | Platform must match. Values: `linux`, `mac`, `windows`. List = any matches.        |
| `exists`        | string         | Path (file or directory) must exist. Variables are resolved.                       |
| `exec`          | string         | Shell command must exit with code `0`.                                             |
| `target_exists` | boolean        | `true` — pass only if target exists. `false` — pass only if target does not exist. |
| `not`           | boolean        | `true` — invert the result of all checks in this condition object.                 |

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

Backup only happens when the target file already exists. If the backup path already exists it is overwritten — use the [counter pattern](#counter-pattern) or `$datetime` when you want to keep every backup.

#### Path variables

The following variables are available in `backup:` patterns and in all processors (`replace:`, `post:`, template rendering).

Given target path `/home/user/project/config.yaml`:

| Variable    | Value                             |
| ----------- | --------------------------------- |
| `$path`     | `/home/user/project/config.yaml`  |
| `$filename` | `config.yaml`                     |
| `$basename` | `config`                          |
| `$ext`      | `yaml` (no leading dot)           |
| `$dirname`  | `/home/user/project`              |
| `$basedir`  | `project`                         |
| `$date`     | `2026-05-20` (pull time)          |
| `$datetime` | `2026-05-20-14-30-00` (pull time) |

`$date` and `$datetime` are injected once at pull start and available everywhere — source URLs, conditions, `replace:`, `post:`, template rendering, and `backup:`. Per-file path variables (`$path`–`$basedir`) are also available in source URLs and conditions, but only when the file entry's map key is a fixed (non-directory) path. They are always available in `replace:`, `post:`, template rendering, and `backup:`.

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

By default, backup paths are restricted to the working directory — the same constraint applied to `target:`. To back up outside the working directory, declare the allowed roots at the top level:

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

Variables are resolved in every string field: target keys, `ref`, `exec` commands, HTTP URLs, local paths, `raw` content, `replace` rules (`from` and `to`), and `post` scripts.

For `raw:` sources, variables are resolved in the content itself. For all other source types (`http`, `local`, `github`, `gitlab`, `exec`), variables are only resolved in the fields that locate the source (URL, path, command) — not in the fetched content. Use a `replace:` rule if you need to substitute values in fetched content.

**Shell safety in `exec:` and `post:`** — when a variable is substituted into an `exec:` command or a `post:` script, its value is automatically single-quoted. This means shell metacharacters (`;`, `&&`, `$(...)`, etc.) in the value are treated as literal data and are never executed. The surrounding command template itself is not quoted, so the static shell syntax you write is executed as usual. On Unix the script runs via `sh -c`; on Windows it runs via PowerShell (`-EncodedCommand`).

```yaml
variables:
  version: '1.0'

files:
  data.json:
    src:
      exec: curl https://example.com/api/$version/data # expands to: curl …/'1.0'/data
    post: sed 's/$version/replaced/g' # expands to: sed 's/'\''1.0'\''/replaced/g'
```

**Escaping a literal `$`** — use `$$` to emit a literal `$` that is not treated as a variable reference. This is useful in `exec:` and `post:` scripts that contain shell or PowerShell syntax with `$`-prefixed identifiers (e.g. PowerShell built-ins like `$$true` or `$$null`):

```yaml
files:
  out.txt:
    src:
      # On Windows exec: runs in PowerShell — $true is a PS built-in, needs $$
      exec: "if ($$true) { Write-Output 'yes' }"
    post: sed 's/$$HOME/redacted/g' # $HOME would be treated as an avanti variable
```

`$$` produces a single `$` after substitution. `$$$name` produces `$` followed by the value of `name`.

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

`$latest` is a reserved keyword that resolves to the latest published version and cannot be used as a variable name. For GitLab it resolves to the latest tag sorted by semantic version. For GitHub it resolves to the tag of the latest release; if the repository has no releases, it falls back to the most recently created tag. For Bitbucket it resolves to the latest tag sorted by name; if no tags exist, it falls back to the repository's default branch.

When `ref` is omitted, all source types (GitHub, GitLab, Bitbucket, git) resolve to the repository's default branch.

`$self` is a reserved keyword that expands to the absolute path of the active config file. It is injected automatically and cannot be used as a variable name. Use it anywhere a variable is valid — `exec:` commands, `replace:` rules, `exists:` conditions, `post:` scripts, or any source field:

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

**Pull-time variables** — available everywhere (source URLs, conditions, `replace:`, `post:`, template rendering, `backup:`):

| Variable    | Value                                   | Example               |
| ----------- | --------------------------------------- | --------------------- |
| `$date`     | Current date `YYYY-MM-DD`               | `2026-05-20`          |
| `$datetime` | Current date+time `YYYY-MM-DD-HH-mm-ss` | `2026-05-20-14-30-00` |

**Per-file path variables** — derived from each file entry's resolved target path. Available in `replace:`, `post:`, template rendering, and `backup:`. Also available in source URLs and conditions when the entry has a fixed (non-directory) map key as its target path.

Example with working directory `/home/user/project` and map key `config.yaml`:

| Variable    | Value                            |
| ----------- | -------------------------------- |
| `$path`     | `/home/user/project/config.yaml` |
| `$filename` | `config.yaml`                    |
| `$basename` | `config`                         |
| `$ext`      | `yaml` (no leading dot)          |
| `$dirname`  | `/home/user/project`             |
| `$basedir`  | `project`                        |

```yaml
files:
  config.yaml: # map key is the target path, resolved against workingDir
    src: https://api.example.com/$filename?ts=$datetime # per-file vars + $datetime in source URLs
    replace:
      - from: GENERATED_AT
        to: $date # $date available in processors
    post: echo "wrote $filename" >> $dirname/avanti.log # per-file vars available in post
    backup: $dirname/$basename.%dd.$ext # per-file vars available in backup
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

`$self` supports all the same source types, `replace`, `post`, and YAML/JSON merge options as any other file entry. See [Self-managing Config](#self-managing-config) in the Use Cases section for a full worked example.

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
