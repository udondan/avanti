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
