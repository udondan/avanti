# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package manager

This project uses **Bun**. Always use `bun` / `bunx` — never `npm` or `npx`.

## Commands

```bash
bun run build        # Compile TypeScript → dist/
bun run dev          # Run CLI directly via tsx (no build needed)
bun test             # Run tests once
bun run test:watch   # Run tests in watch mode
bun run lint         # Run ESLint
bun run format       # Format with Prettier
bun run format:check # Check formatting without writing
```

Run a single test file:

```bash
bunx vitest run test/config.test.ts
```

## Architecture

**avanti** is a CLI tool that syncs local files from declarative YAML specs. Two commands: `diff` (preview changes) and `pull` (apply with confirmation prompt).

### Data flow

1. `cli.ts` — Commander.js entry point, routes to commands
2. `config.ts` — Resolves and parses the config file; auto-detects `.avanti.yml`, `.avanti.yaml`, `avanti.yml`, `avanti.yaml` (case-insensitive) when no explicit `--config` path is given
3. `sources/index.ts` — Orchestrates fetching across all source types
4. `processors/` — Transforms fetched content (replacements, shell pipes)
5. `diff.ts` — Computes and renders git-diff-style output
6. `writer.ts` — Stages writes to a temp dir, then atomically commits

### Source types (`src/sources/`)

| File        | Source type                 | Mechanism                                     |
| ----------- | --------------------------- | --------------------------------------------- |
| `http.ts`   | HTTP/HTTPS URLs             | Node.js `https` module with redirect handling |
| `local.ts`  | Local paths (supports `~/`) | `fs` with recursive directory traversal       |
| `exec.ts`   | Shell commands              | `child_process.execSync`                      |
| `gitlab.ts` | GitLab files/dirs           | Shells out to `glab` CLI                      |
| `github.ts` | GitHub files/dirs           | Shells out to `gh` CLI                        |

A `src` value can be a string (auto-detected as HTTP or local path) or an object with a `type` field (`exec`, `gitlab`, `github`). Multi-source entries use a list of `src` values whose outputs are concatenated.

### Processors (`src/processors/`)

- `replace.ts` — String or regex substitutions on fetched content
- `post.ts` — Pipes content through a shell script via stdin/stdout

### Exit codes

- `0` — Success / no changes detected
- `1` — Changes detected (in `diff` command)
- `2` — Error
