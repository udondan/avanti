# avanti

Assemble local files from any source via a declarative YAML spec.

## Features

- Fetch files from **HTTP/HTTPS**, **local paths**, **GitLab** (via `glab`), **GitHub** (via `gh`), or **shell commands**
- **Multi-source entries** — combine multiple sources into a single file by providing `src` as a list
- **Atomic writes** — all files are staged to a temp dir first; targets are only written if everything succeeds
- **Diff preview** — see exactly what will change before applying
- **Post-processing** — apply text replacements (string or regex) and/or pipe content through a shell script
- **Directory sync** — recursively sync directories from GitLab/GitHub/local sources

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

```
avanti [options] [command]

Options:
  -c, --config <path>   path to config file (default: "avanti.yml")

Commands:
  diff                  Show diff between remote sources and local files
  pull [--yes]          Pull remote sources and write to local files
```

### `avanti diff`

Shows a colored git-diff-like output of what would change. Exits `0` if no changes, `1` if changes detected.

### `avanti pull`

Fetches all sources, shows the diff, and prompts for confirmation before writing. Use `--yes` to skip the prompt.

## Configuration

Create a `avanti.yml` in your project root:

```yaml
files:
  - src: http://www.example.com/example.yml
    target: my-example.yml
    replace:
      - from: '{EMAIL}'
        to: you@example.com
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

| Field     | Required    | Description                                                                                                               |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src`     | Yes         | Source (see below). May be a single source or a **list** of sources to concatenate.                                       |
| `target`  | Conditional | Local path to write to. Required for `exec:` sources and when `src` is a list. May be omitted when filename is inferable. |
| `ref`     | No          | Branch, tag, or `$latest` (resolves to latest tag). GitLab/GitHub only.                                                   |
| `mode`    | No          | File permission mode, e.g. `"0755"`                                                                                       |
| `replace` | No          | List of `{from, to}` replacement rules. `from` may be a plain string or `/pattern/flags` regex.                           |
| `post`    | No          | Shell script. Content is piped via stdin; stdout is used as the result. Runs after `replace`.                             |

### Source Types

**Plain string** — HTTP/HTTPS URL or local path:

```yaml
src: https://example.com/file.txt
src: ~/templates/file.txt
src: /absolute/path/file.txt
```

**Map** — for exec, gitlab, github:

```yaml
src:
  exec: <shell command>          # stdout becomes file content; target required

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

## Exit Codes

| Code | Meaning                         |
| ---- | ------------------------------- |
| `0`  | Success / no changes            |
| `1`  | Changes detected (diff command) |
| `2`  | Error                           |

## Development

```sh
git clone ...
npm install
npm run dev -- --help       # run via tsx
npm test                    # run tests
npm run build               # compile to dist/
```
