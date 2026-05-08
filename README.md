# avanti

Assemble local files from any source via a declarative YAML spec.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
  - [`avanti diff`](#avanti-diff)
  - [`avanti pull`](#avanti-pull)
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
  - [Directory Sources](#directory-sources)
  - [JSON Merging](#json-merging)
  - [YAML Merging](#yaml-merging)
  - [Variables](#variables)
  - [Authentication](#authentication)
  - [Private Instances](#private-instances)
- [Use Cases](#use-cases)
  - [Composable AI Agent Instructions (CLAUDE.md / AGENTS.md)](#composable-ai-agent-instructions-claudemd--agentsmd)
  - [Shared Tooling Config (Renovate, ESLint, Prettier, TSConfig)](#shared-tooling-config-renovate-eslint-prettier-tsconfig)
  - [CI/CD: Shared Workflow Fragments](#cicd-shared-workflow-fragments)
  - [CI/CD: Scheduled Sync PR](#cicd-scheduled-sync-pr)
  - [Environment-Specific Config from a Single Spec](#environment-specific-config-from-a-single-spec)
  - [Secrets from Vault or S3](#secrets-from-vault-or-s3)
  - [Multi-Project Deployment](#multi-project-deployment)
  - [Docker Compose Layering](#docker-compose-layering)
  - [Developer Onboarding Bootstrap](#developer-onboarding-bootstrap)
  - [Self-managing Config](#self-managing-config)
  - [Avanti as a Package Manager](#avanti-as-a-package-manager)
- [Exit Codes](#exit-codes)
- [Development](#development)

## Features

- Fetch files from **HTTP/HTTPS**, **local paths**, **GitLab** (via `glab`), **GitHub** (via `gh`), **Bitbucket**, **any git remote**, **S3**, **HashiCorp Vault**, **shell commands**, or **inline raw content**
- **Multi-source entries** — combine multiple sources into a single file by providing `src` as a list
- **Atomic writes** — all files are staged to a temp dir first; targets are only written if everything succeeds
- **Diff preview** — see exactly what will change before applying, or compare against any past pull
- **Post-processing** — apply text replacements (string or regex) and/or pipe content through a shell script
- **Directory sync** — recursively sync directories from GitLab/GitHub/Bitbucket/git/S3/local sources
- **JSON merging** — deep-merge multiple JSON/JSONC sources with configurable conflict, array, and object strategies
- **YAML merging** — deep-merge multiple YAML/YML sources with the same strategies, with full comment preservation
- **Variables** — define reusable values in a `variables:` block and reference them anywhere with `$name`; use `$env:NAME` for environment variables
- **History** — every pull is recorded; inspect what changed, revert the whole project to a past state, or fully undo all avanti changes
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
  -c, --config <path|url>     path or remote spec for config file (default: auto-detected)
  -w, --working-dir <path>    working directory for resolving paths (default: current directory)

Commands:
  diff [pullId]               Show diff between remote sources and local files, or vs a past pull
  pull [--yes]                Pull remote sources and write to local files
  log [file]                  Show pull history for the current project
  revert [pullId] [--yes]     Atomically revert all project files to a past pull state
  reset [--yes]               Restore all tracked files to their pre-avanti state
```

### `avanti diff`

Shows a colored git-diff-like output of what would change. Exits `0` if no changes, `1` if changes detected.

### `avanti pull`

Fetches all sources, shows the diff, and prompts for confirmation before writing. Use `--yes` to skip the prompt.

When avanti has previously synced a directory from a remote source and a file is no longer present in that source, the file is treated as stale: if avanti created it, it is deleted; if it existed before avanti first touched it, the original content is restored. Stale file changes appear in the diff before you confirm.

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
  - src: http://www.example.com/example.yml
    target: my-example.yml
    replace:
      - from: '{EMAIL}'
        to: $email
      - from: /\d+/
        to: number

  - src: ~/some/local/file.sh
    target: file.sh
    mode: '0777'

  - src:
      exec: glab api "projects/group%2Fproject/repository/files/some-file.yaml/raw?ref=main"
    target: some-file.yml
    post: sed -e 's/v3/v4/g'

  - src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: $latest
    # target omitted → renovate.json

  - src:
      github:
        repo: org/repo
        file: scripts/
        ref: main
    target: local-scripts/
```

### File Entry Fields

| Field     | Required    | Description                                                                                                                                                                                                                              |
| --------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`     | Yes         | Source (see below). May be a single source or a **list** of sources to concatenate.                                                                                                                                                      |
| `target`  | Conditional | Local path to write to. Required for `exec:` and `raw:` sources and when `src` is a list. May be omitted when filename is inferable. End with `/` when `src` is a directory — files are written inside, preserving their relative paths. |
| `mode`    | No          | File permission mode, e.g. `"0755"`                                                                                                                                                                                                      |
| `replace` | No          | List of `{from, to}` replacement rules. `from` may be a plain string or `/pattern/flags` regex.                                                                                                                                          |
| `post`    | No          | Shell script. Content is piped via stdin; stdout is used as the result. Runs after `replace`.                                                                                                                                            |
| `json`    | No          | JSON merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.json` or `.jsonc` extension. Use `true`/`false` to force on or off regardless of extension.                                         |
| `yaml`    | No          | YAML merge/format options (see below). When omitted, merging is auto-enabled if all sources have a `.yaml` or `.yml` extension. Use `true`/`false` to force on or off regardless of extension. Comments are preserved in merged output.  |

### Source Types

**Plain string** — HTTP/HTTPS URL or local path:

```yaml
src: https://example.com/file.txt
src: ~/templates/file.txt
src: /absolute/path/file.txt
```

**Map** — for exec, gitlab, github, bitbucket, git, s3, vault, raw:

```yaml
src:
  exec: <shell command>          # stdout becomes file content; target required

src:
  raw: |                         # inline content; target required
    your content here

src:
  gitlab:
    project: group/repo          # GitLab project path
    file: path/to/file.txt       # file or directory in repo
    ref: main                    # branch, tag, or $latest (optional)

src:
  github:
    repo: owner/repo             # GitHub owner/repo
    file: path/to/file.txt       # file or directory in repo
    ref: main                    # branch, tag, or $latest (optional)

src:
  bitbucket:
    workspace: my-workspace      # Bitbucket workspace slug
    repo: my-repo                # repository slug
    file: path/to/file.txt       # file or directory in repo
    ref: main                    # branch, tag, or $latest (optional)

src:
  git:
    repo: https://github.com/org/repo.git  # any git remote (HTTPS or SSH)
    file: path/to/file.txt                 # file or directory in repo
    ref: main                              # branch, tag, or commit hash (optional)

src:
  s3: s3://my-bucket/path/to/file.txt      # S3 URI; end with / for a prefix sync

src:
  vault:
    path: secret/myapp/config   # Vault KV path (mount/subpath)
    field: db_password          # specific field to extract (optional; omit for full JSON)
```

### Directory Sources

Any source type that references a path (local, GitLab, GitHub, Bitbucket, git, S3) can point to a directory instead of a single file. End the path with `/` to declare it a directory explicitly; without a trailing slash the tool probes the remote to decide.

When `src` is a directory, the matched files are written individually under `target` (which must also end with `/`), preserving the subdirectory structure relative to the source root:

```yaml
# All files under skills/ in the GitLab repo are written into local skills.new/
- src:
    gitlab:
      project: group/repo
      file: skills/
      ref: main
  target: skills/

# GitHub directory → local directory
- src:
    github:
      repo: org/repo
      file: .github/workflows/
      ref: main
  target: .github/workflows/

# Bitbucket directory → local directory
- src:
    bitbucket:
      workspace: my-workspace
      repo: shared-configs
      file: eslint/
      ref: main
  target: eslint/

# git remote directory → local directory (any host)
- src:
    git:
      repo: https://github.com/org/repo.git
      file: .github/workflows/
      ref: main
  target: .github/workflows/

# S3 prefix → local directory (trailing / triggers sync)
- src:
    s3: s3://my-bucket/configs/
  target: configs/

# Local directory → local directory
- src: ~/shared/hooks/
  target: .githooks/
```

Directory sources cannot be mixed into a multi-source list (`src` as a list), because the list mode always produces a single file.

**List** — combine multiple sources into one file (all source types supported; `target` required):

```yaml
src:
  - https://example.com/header.txt
  - exec: echo "# generated"
  - gitlab:
      project: org/repo
      file: footer.txt
      ref: main
target: combined.txt
```

Sources are fetched in order and joined with a newline. Post-processing (`replace`, `post`) is applied to the combined result. If any source fails, the entire entry is aborted.

### JSON Merging

When all sources in a list have a `.json` or `.jsonc` extension, JSON merging is enabled automatically — no extra config needed:

```yaml
files:
  - src:
      - ./team.jsonc
      - ./my.jsonc
    target: merged.jsonc
```

To merge sources that don't have a JSON extension (e.g. `exec:`, `raw:`, or a URL without `.json`), set `json: true`:

```yaml
files:
  - src:
      - exec: cat defaults.json
      - ./overrides.json
    target: merged.json
    json: true
```

To opt out of auto-detection and force plain concatenation, set `json: false`.

**Fine-grained options** — pass an object to control merge behavior:

```yaml
files:
  - src:
      - ./defaults.json
      - type: github
        repo: org/configs
        file: overrides.json
    target: merged.json
    json:
      conflicts: last_wins # abort | first_wins | last_wins (default)
      arrays: replace # replace (default) | concat
      objects: merge # merge (default) | replace
```

- `conflicts` — what to do when the same key holds a scalar (or an array/object when their strategy is `replace`):
  - `last_wins` _(default)_ — the last source's value wins
  - `first_wins` — the first source's value is kept
  - `abort` — throw an error (identical values are not considered a conflict)
- `arrays` — how to combine arrays at the same key:
  - `replace` _(default)_ — the later source's array replaces the earlier one
  - `concat` — arrays are concatenated (no deduplication)
- `objects` — how to combine objects (maps) at the same key:
  - `merge` _(default)_ — deep merge, applying the same rules recursively to nested keys
  - `replace` — the later source's object replaces the earlier one entirely

**Pretty-printing a single file** — `json` works on single-source entries too. Auto-detection applies here as well, so a single `.json` source is pretty-printed automatically:

```yaml
files:
  - src: ./minified.json
    target: pretty.json
```

### YAML Merging

When all sources in a list have a `.yaml` or `.yml` extension, YAML merging is enabled automatically — no extra config needed:

```yaml
files:
  - src:
      - ./defaults.yaml
      - ./overrides.yml
    target: merged.yaml
```

To merge sources that don't have a YAML extension (e.g. `exec:`, `raw:`, or a URL without `.yaml`), set `yaml: true`:

```yaml
files:
  - src:
      - exec: cat defaults.yaml
      - ./overrides.yaml
    target: merged.yaml
    yaml: true
```

To opt out of auto-detection and force plain concatenation, set `yaml: false`.

**Fine-grained options** — pass an object to control merge behavior:

```yaml
files:
  - src:
      - ./defaults.yaml
      - type: github
        repo: org/configs
        file: overrides.yaml
    target: merged.yaml
    yaml:
      conflicts: last_wins # abort | first_wins | last_wins (default)
      arrays: replace # replace (default) | concat
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
- `objects` — how to combine objects (maps) at the same key:
  - `merge` _(default)_ — deep merge, applying the same rules recursively to nested keys
  - `replace` — the later source's object replaces the earlier one entirely

**Comment preservation** — YAML comments are preserved in the merged output. Comments from all sources are retained in their original positions.

**Pretty-printing a single file** — `yaml` works on single-source entries too. Auto-detection applies here as well, so a single `.yaml` or `.yml` source is normalized automatically:

```yaml
files:
  - src: ./config.yaml
    target: config.yaml
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
  - src:
      gitlab:
        project: group/project
        file: renovate.json
        ref: $version # resolved to "1.2.3"
    replace:
      - from: '{EMAIL}'
        to: $email # resolved to "you@example.com"
```

Variables are resolved in every string field: `target`, `ref`, `exec` commands, HTTP URLs, local paths, `raw` content, `replace` rules (`from` and `to`), and `post` scripts.

For `raw:` sources, variables are resolved in the content itself. For all other source types (`http`, `local`, `github`, `gitlab`, `exec`), variables are only resolved in the fields that locate the source (URL, path, command) — not in the fetched content. Use a `replace:` rule if you need to substitute values in fetched content.

**Environment variables** use the `$env:NAME` form:

```yaml
replace:
  - from: /secret-token/
    to: $env:MY_SECRET # reads process.env.MY_SECRET at runtime
```

Referencing an undefined variable or a missing environment variable is an error.

`$latest` is a reserved keyword that resolves to the latest published version and cannot be used as a variable name. For GitLab it resolves to the latest tag sorted by semantic version. For GitHub it resolves to the tag of the latest release; if the repository has no releases, it falls back to the most recently created tag.

### Authentication

Public repositories on github.com and gitlab.com work without any configuration. For private repositories or instances, supply credentials via environment variables:

| Platform  | Environment variable(s)                                          | Notes                                      |
| --------- | ---------------------------------------------------------------- | ------------------------------------------ |
| GitHub    | `GITHUB_TOKEN`                                                   | `Authorization: Bearer <token>`            |
| GitLab    | `GITLAB_TOKEN` or `GITLAB_PRIVATE_TOKEN`                         | `PRIVATE-TOKEN: <token>`                   |
| Bitbucket | `BITBUCKET_TOKEN`                                                | `Authorization: Bearer <token>`            |
| Bitbucket | `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`                  | Basic auth (alternative to token)          |
| S3        | Standard AWS env vars (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, etc.) | Delegates entirely to the `aws` CLI        |
| Vault     | `VAULT_TOKEN` + `VAULT_ADDR` (and optionally `VAULT_NAMESPACE`)  | Used when the `vault` CLI is not installed |

If a GitHub or GitLab request fails with a 401, 403, or 404 response and `gh` / `glab` is installed and authenticated, the tool falls back to the CLI automatically. This means existing CLI setups continue to work for private repos without any extra configuration.

**Vault** uses the `vault` CLI when it is installed (picks up `VAULT_TOKEN`, `~/.vault-token`, and any other auth methods configured in the CLI). If the CLI is not available, it falls back to the HTTP API using `VAULT_ADDR` and `VAULT_TOKEN`.

**S3** delegates entirely to the `aws` CLI, so any credential method that works with `aws s3 cp` (env vars, `~/.aws/credentials`, instance profiles, etc.) works here too.

### Private Instances

**GitLab** — set `GITLAB_HOST` to override the default `gitlab.com`:

```bash
GITLAB_HOST=gitlab.mycompany.com avanti pull
```

**GitHub Enterprise Server** — set `GITHUB_HOST` to override the default `github.com` (API requests go to `https://{GITHUB_HOST}/api/v3`):

```bash
GITHUB_HOST=github.mycompany.com avanti pull
```

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
  - src:
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
    target: CLAUDE.md
```

### Shared Tooling Config (Renovate, ESLint, Prettier, TSConfig)

A platform team owns canonical configs in a central repo. Projects pull them and stay current. Pin all files to the same version in one place — bump `standards_ref` and `avanti diff` shows every file that will change before you apply it.

```yaml
variables:
  standards_ref: v2.4.1

files:
  - src:
      github:
        repo: org/standards
        file: renovate.json
        ref: $standards_ref

  - src:
      github:
        repo: org/standards
        file: eslint.config.js
        ref: $standards_ref

  - src:
      github:
        repo: org/standards
        file: tsconfig.base.json
        ref: $standards_ref
```

For YAML-based configs (Helm values, k8s manifests, Docker Compose overrides), use YAML merge to layer a shared base with project-specific values. Comments in both files are preserved in the merged output:

```yaml
files:
  - src:
      - github:
          repo: org/platform
          file: helm/base-values.yaml # shared defaults for all services
          ref: $standards_ref
      - ./helm/values.yaml # project overrides
    target: ./helm/merged-values.yaml
    yaml:
      conflicts: last_wins # project overrides win
      arrays: concat # e.g. extra env vars are appended, not replaced
```

### CI/CD: Shared Workflow Fragments

Pull reusable CI steps from a central repo into each project. A managed header makes it obvious the file should not be edited by hand.

```yaml
files:
  - src:
      - raw: |
          # THIS FILE IS MANAGED — run `avanti pull` to update
      - github:
          repo: org/ci-templates
          file: workflows/security-scan.yml
          ref: main
    target: .github/workflows/security-scan.yml
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
  - src:
      github:
        repo: org/infra
        file: k8s/deployment-template.yaml
        ref: $env:DEPLOY_VERSION
    target: k8s/deployment.yaml
    replace:
      - from: '{ENV}'
        to: $env:ENVIRONMENT
      - from: '{REGION}'
        to: $region
```

CI sets `DEPLOY_VERSION` and `ENVIRONMENT`; the config pins every file to exactly the version being deployed.

### Secrets from Vault or S3

Pull secrets at runtime and write them to local files with tight permissions. The native `vault:` and `s3:` sources handle auth automatically via the CLI or env vars — no shell scripting needed.

```yaml
files:
  # Single field from a Vault KV secret
  - src:
      vault:
        path: secret/myapp/db
        field: password
    target: config/db_password.txt
    mode: '0600'

  # Full Vault secret as JSON
  - src:
      vault:
        path: secret/myapp/config
    target: config/secrets.json
    mode: '0600'

  # Config file stored in S3
  - src:
      s3: s3://my-bucket/configs/app.json
    target: config/app.json
    mode: '0600'
```

For AWS SSM or other secret stores without a dedicated source type, `exec:` still works:

```yaml
files:
  - src:
      exec: >
        aws ssm get-parameter
        --name /myapp/db-config
        --with-decryption
        --query Parameter.Value --output text
    target: config/db.json
    mode: '0600'
```

### Multi-Project Deployment

Pair a shared config with `-w` to stamp files across many service directories without duplicating the spec:

```sh
for dir in services/*/; do
  avanti -c shared/avanti.yml -w "$dir" pull --yes
done
```

### Docker Compose Layering

Maintain a shared `docker-compose.yml` in a central repo and let each project layer its own overrides on top. A `avanti pull` merges them into a single ready-to-run file — no manual copy-paste, no diverging base definitions.

```yaml
files:
  - src:
      - github:
          repo: org/platform
          file: docker/compose-base.yml # shared service definitions and networks
          ref: main
      - ./docker-compose.override.yml # project-specific ports, volumes, env vars
    target: ./docker-compose.yml
    yaml:
      conflicts: last_wins # local overrides win
      arrays: concat # environment and volumes lists are appended, not replaced
```

The base file defines the canonical service images, healthchecks, and network topology. Each project's override only declares what differs — a different port, an extra volume mount, a local build context. Comments from both files survive in the merged output, so the generated `docker-compose.yml` stays readable and self-documenting.

### Developer Onboarding Bootstrap

A single `avanti pull` populates a new project with everything it needs: editor config, CI workflows, linting rules, AI instructions — all from blessed central sources, all up to date.

```yaml
files:
  - src:
      github:
        repo: org/standards
        file: .editorconfig
        ref: main

  - src:
      github:
        repo: org/standards
        file: .prettierrc
        ref: main

  - src:
      - raw: |
          # AI Assistant Guidelines
          <!-- THIS FILE IS MANAGED — run `avanti pull` to update -->
      - github:
          repo: org/ai-standards
          file: CLAUDE.md
          ref: main
    target: CLAUDE.md

  - src:
      github:
        repo: org/ci-templates
        file: workflows/
        ref: main
    target: .github/workflows/
```

### Self-managing Config

avanti can sync any file — including its own config. Put the canonical config in a central repo and add a self-update entry. Every `avanti pull` refreshes the config alongside all other managed files; the updated config takes effect on the next run.

```yaml
# ~/.avanti.yml
variables:
  dotfiles: myorg/dotfiles

files:
  # Keep this config itself up to date
  - src:
      github:
        repo: $dotfiles
        file: avanti.yml
        ref: $latest
    target: ~/.avanti.yml

  # Everything else the config manages
  - src:
      github:
        repo: $dotfiles
        file: .zshrc
    target: ~/.zshrc

  - src:
      github:
        repo: $dotfiles
        file: .gitconfig
    target: ~/.gitconfig
```

**Composable self-managing config** — YAML merge takes this further. Instead of one canonical config, compose your `~/.avanti.yml` from org-wide defaults, team additions, and personal overrides — all merged automatically on every pull:

```yaml
# ~/.avanti.yml — bootstrapped once, then self-updating via YAML merge
files:
  - src:
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
    target: ~/.avanti.yml
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
```

The config format is `github:owner/repo:path/to/file.yml[@ref]` and `gitlab:group/project:path/to/file.yml[@ref]`. The same token auth and `gh`/`glab` CLI fallback that applies to sources also applies here, so private repos work without any extra setup.

This scales to any number of machines or containers. Update the central repo once; every client picks up the change on its next pull. No config drift, no manual distribution.

### Avanti as a Package Manager

Think of avanti like `package.json` — your config declares what you consume and where, and each source repo is a "package" that owns its files. Adding a dependency means adding entries; updating means running `avanti pull`. Teams publish their own snippets; projects compose from them.

```yaml
# .avanti.yml — pulling from multiple upstream "packages"
variables:
  frontend_standards: myorg/frontend-standards
  platform: myorg/platform-templates
  standards_ref: $latest

files:
  # "package": frontend team standards
  - src:
      github:
        repo: $frontend_standards
        file: eslint.config.js
        ref: $standards_ref
    target: eslint.config.js

  - src:
      github:
        repo: $frontend_standards
        file: .prettierrc
        ref: $standards_ref
    target: .prettierrc

  # "package": platform team CI templates
  - src:
      github:
        repo: $platform
        file: workflows/test.yml
        ref: $standards_ref
    target: .github/workflows/test.yml

  - src:
      github:
        repo: $platform
        file: workflows/deploy.yml
        ref: $standards_ref
    target: .github/workflows/deploy.yml
```

The two patterns compose naturally. Each team publishes its own avanti snippet alongside the files it owns. A central config pulls in those snippets and merges them into the canonical config that all clients self-manage:

```yaml
# myorg/devtools — avanti.yml assembled from team snippets
files:
  # Self-update
  - src:
      github:
        repo: myorg/devtools
        file: avanti.yml
        ref: $latest
    target: ~/.avanti.yml

  # Snippet contributed by the frontend team
  - src:
      github:
        repo: myorg/frontend-standards
        file: avanti-snippet.yml # their entries live here
        ref: $latest
    target: /tmp/avanti-snippets/frontend.yml

  # Snippet contributed by the platform team
  - src:
      github:
        repo: myorg/platform-templates
        file: avanti-snippet.yml
        ref: $latest
    target: /tmp/avanti-snippets/platform.yml
```

Each team controls what they publish and when they cut a new release. Projects opt in by referencing the snippet. `avanti diff` shows exactly what would change before you apply any update — the same safety you get with a lockfile review in npm or Cargo.

## Exit Codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | Success / no changes            |
| `1`  | Changes detected (diff command) |
| `2`  | Error                           |

## Development

```sh
git clone ...
bun install
bun run dev -- --help       # run via tsx
bun test                    # run tests
bun run build               # compile to dist/
```
