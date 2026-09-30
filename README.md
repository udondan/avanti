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
