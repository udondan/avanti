# avanti

Assemble local files from any source via a declarative YAML spec.

## Features

- Fetch files from **HTTP/HTTPS**, **local paths**, **GitLab** (via `glab`), **GitHub** (via `gh`), **shell commands**, or **inline raw content**
- **Multi-source entries** — combine multiple sources into a single file by providing `src` as a list
- **Atomic writes** — all files are staged to a temp dir first; targets are only written if everything succeeds
- **Diff preview** — see exactly what will change before applying
- **Post-processing** — apply text replacements (string or regex) and/or pipe content through a shell script
- **Directory sync** — recursively sync directories from GitLab/GitHub/local sources
- **Variables** — define reusable values in a `variables:` block and reference them anywhere with `$name`; use `$env:NAME` for environment variables

## Requirements

- Node.js 18+
- `glab` CLI (for GitLab sources) — [install](https://gitlab.com/gitlab-org/cli)
- `gh` CLI (for GitHub sources) — [install](https://cli.github.com)

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
  -c, --config <path>         path to config file (default: auto-detected)
  -w, --working-dir <path>    working directory for resolving paths (default: current directory)

Commands:
  diff                        Show diff between remote sources and local files
  pull [--yes]                Pull remote sources and write to local files
```

### `avanti diff`

Shows a colored git-diff-like output of what would change. Exits `0` if no changes, `1` if changes detected.

### `avanti pull`

Fetches all sources, shows the diff, and prompts for confirmation before writing. Use `--yes` to skip the prompt.

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

### Source Types

**Plain string** — HTTP/HTTPS URL or local path:

```yaml
src: https://example.com/file.txt
src: ~/templates/file.txt
src: /absolute/path/file.txt
```

**Map** — for exec, gitlab, github, raw:

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
    ref: main                    # branch or tag (optional)
```

### Directory Sources

Any source type that references a path (local, GitLab, GitHub) can point to a directory instead of a single file. End the path with `/` to declare it a directory explicitly; without a trailing slash the tool probes the remote to decide.

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

**Environment variables** use the `$env:NAME` form:

```yaml
replace:
  - from: /secret-token/
    to: $env:MY_SECRET # reads process.env.MY_SECRET at runtime
```

Referencing an undefined variable or a missing environment variable is an error.

`$latest` is reserved for GitLab's "latest tag" resolution and cannot be used as a variable name.

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

### Secrets from Vault or AWS SSM

Use `exec:` to pull secrets at runtime and write them to a local file. Config variables handle structure; env vars keep credentials out of git.

```yaml
variables:
  org: acme
  region: us-east-1

files:
  - src:
      exec: >
        aws ssm get-parameter
        --name /$org/$region/db-config
        --profile $env:AWS_PROFILE
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
