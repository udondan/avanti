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
