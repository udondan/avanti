# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package manager

This project uses **Bun**. Always use `bun` / `bunx` — never `npm` or `npx`.

## Commands

```bash
mise run build          # Compile TypeScript → dist/
mise run dev            # Run CLI directly via tsx (no build needed)
mise run test           # Run tests once
mise run test:watch     # Run tests in watch mode
mise run lint           # Run ESLint
mise run format         # Format with Prettier
mise run format:check   # Check formatting without writing
```

Run a single test file:

```bash
mise exec -- bunx vitest run test/config.test.ts
```

## Architecture

**avanti** is a CLI tool that assembles local files from declarative YAML specs.

### CLI commands (`src/commands/`)

| Command  | Description                                                         |
| -------- | ------------------------------------------------------------------- |
| `diff`   | Show diff between remote sources and local files (exit 1 = changes) |
| `pull`   | Fetch sources, show diff, prompt to apply; `-y` skips prompt        |
| `log`    | Show pull history; `log <file>` shows version history for one file  |
| `revert` | Restore files to a past pull state; no arg = undo last pull         |
| `reset`  | Restore all tracked files to their pre-avanti state                 |

### Data flow

1. `cli.ts` — Commander.js entry point; global flags: `--config`, `--working-dir`
2. `config.ts` — Resolves and parses the config file; auto-detects `.avanti.yml`, `.avanti.yaml`, `avanti.yml`, `avanti.yaml` (case-insensitive) when no explicit `--config` path is given
3. `variables.ts` — Validates and resolves `$varname` (config variables) and `$env:NAME` (env vars) in strings; `$latest` is a reserved sentinel for newest tag
4. `sources/index.ts` — Orchestrates fetching across all source types
5. `processors/` — Transforms fetched content (replacements, shell pipes, JSON/YAML merge)
6. `diff.ts` — Computes and renders git-diff-style output
7. `writer.ts` — Stages writes to a temp dir, then atomically commits
8. `history.ts` — Persists versioned file snapshots at `~/.config/avanti/` (overridable via `$AVANTI_HISTORY_DIR`)

### Source types (`src/sources/`)

- **`http.ts`** (plain URL) — `fetch` with retry/rate-limit backoff
- **`local.ts`** (plain path) — `fs` with recursive directory traversal; `~/` supported
- **`exec.ts`** (`exec:`) — `child_process.execSync`
- **`gitlab.ts`** (`gitlab:`) — shells out to `glab` CLI
- **`github.ts`** (`github:`) — shells out to `gh` CLI
- **`bitbucket.ts`** (`bitbucket:`) — Bitbucket REST API; auth via `BITBUCKET_TOKEN` or `BITBUCKET_USERNAME`+`BITBUCKET_APP_PASSWORD`
- **`git.ts`** (`git:`) — `git clone --depth 1` into a temp dir
- **`s3.ts`** (`s3:`) — `aws s3 cp` / `aws s3 sync` CLI
- **`vault.ts`** (`vault:`) — `vault` CLI or `VAULT_ADDR`+`VAULT_TOKEN` HTTP API

A `src` value is a plain string (auto-detected as HTTP or local path) or an object with a source-type key. Multi-source entries use a list of `src` values whose outputs are concatenated.

`fetch.ts` provides `fetchWithRetry` used by HTTP-based sources: retries on 429/5xx, honours `Retry-After` and `X-RateLimit-Reset` headers.

### Processors (`src/processors/`)

- `replace.ts` — String or regex substitutions; variables resolved in `from`/`to`
- `post.ts` — Pipes content through a shell script via stdin/stdout
- `json.ts` — Merges multiple JSON sources; configurable conflict/array/object strategies
- `yaml.ts` — Merges multiple YAML sources with comment preservation

### `$self` and config re-evaluation

The `$self` key in `files:` is the only mechanism for config re-evaluation. When present, the first fetch pass fetches only `$self`, merges the sources into a new config, and then runs a stabilization loop: if the merged config also has `$self`, it is re-fetched until the content converges (fixed point). Once stable, a final pass fetches all non-`$self` entries from the stable config. For local config files the stable content is written back to disk; for remote configs (`--config github:...`) it is in-memory only.

### History storage layout

```text
~/.config/avanti/projects/<sha256(configFile|workingDir)>/
  meta.json          # configFile + workingDir paths
  pulls.jsonl        # one JSON line per pull session
  files/<sha256(absolutePath)>/
    meta.json        # firstSeenAt, existedBeforeAvanti, currentVersion
    v0               # original content (if file existed before avanti)
    v1, v2, ...      # successive pulled versions
```

### Exit codes

- `0` — Success / no changes detected
- `1` — Changes detected (in `diff` command)
- `2` — Error
