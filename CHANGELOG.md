# Changelog

## [0.13.0](https://github.com/udondan/avanti/compare/v0.12.1...v0.13.0) (2026-05-09)


### Features

* **sha:** optional SHA validation per source entry ([#91](https://github.com/udondan/avanti/issues/91)) ([d226fc5](https://github.com/udondan/avanti/commit/d226fc56cbbf992237534fcd6a73cfbe7f966093))

## [0.12.1](https://github.com/udondan/avanti/compare/v0.12.0...v0.12.1) (2026-05-08)


### Bug Fixes

* apply normalizeConfigKey in log, revert, and reset commands ([#76](https://github.com/udondan/avanti/issues/76)) ([c1cf8cf](https://github.com/udondan/avanti/commit/c1cf8cf3944fc817c4a3f7838e2a7d1b461e973f)), closes [#58](https://github.com/udondan/avanti/issues/58)
* **github:** error on truncated Trees API response ([#78](https://github.com/udondan/avanti/issues/78)) ([05ce50a](https://github.com/udondan/avanti/commit/05ce50abe32f3f9996c3ec674a48ec4f82a7ad41)), closes [#61](https://github.com/udondan/avanti/issues/61)
* **history:** getFilesAtPull always overwrites with most recent version ([#77](https://github.com/udondan/avanti/issues/77)) ([0c2ff40](https://github.com/udondan/avanti/commit/0c2ff40af9394e8d9192ff8ce301d95ec94a8bf4)), closes [#57](https://github.com/udondan/avanti/issues/57)
* **history:** write version file before meta.json in stageFileVersion ([#81](https://github.com/udondan/avanti/issues/81)) ([4e5266c](https://github.com/udondan/avanti/commit/4e5266cf50380bc86bf457b4b61f8b9cd98de540)), closes [#63](https://github.com/udondan/avanti/issues/63)
* **local:** throw on unset HOME instead of silently using relative path ([#83](https://github.com/udondan/avanti/issues/83)) ([ae3b69b](https://github.com/udondan/avanti/commit/ae3b69be7bc28ba0d58b5690cc489a8a26d8e41d)), closes [#69](https://github.com/udondan/avanti/issues/69)
* **log:** display timestamps in local time with explicit timezone offset ([#84](https://github.com/udondan/avanti/issues/84)) ([c0a7e22](https://github.com/udondan/avanti/commit/c0a7e22ce90621041f2b03108797e27a7d8bfb10))
* prevent jq filter injection in github source directory listing ([#54](https://github.com/udondan/avanti/issues/54)) ([3e88dab](https://github.com/udondan/avanti/commit/3e88dab228c94679ac0df223cf1154f32ffb225a))
* replace remaining scync references with avanti ([#56](https://github.com/udondan/avanti/issues/56)) ([7fb6799](https://github.com/udondan/avanti/commit/7fb6799b75e517bb3dc6737285fd2a3101e6807b))
* **security:** shell-quote variable values in exec/post commands ([#85](https://github.com/udondan/avanti/issues/85)) ([22b8d73](https://github.com/udondan/avanti/commit/22b8d737c2307c435ff35371fd04388456440fe9)), closes [#65](https://github.com/udondan/avanti/issues/65)
* **sources:** omitting ref now resolves to default branch for GitLab and Bitbucket ([#88](https://github.com/udondan/avanti/issues/88)) ([242338b](https://github.com/udondan/avanti/commit/242338b579c246b48350a61eaa75aca4719e0090)), closes [#64](https://github.com/udondan/avanti/issues/64)
* **test:** resolve Bun/Vitest API gaps in fetch and vault tests ([#87](https://github.com/udondan/avanti/issues/87)) ([dc0bcf7](https://github.com/udondan/avanti/commit/dc0bcf77538438c97ba8f7495636171b48c669ca))
* **writer:** use rename-based atomic write instead of copyFileSync ([#79](https://github.com/udondan/avanti/issues/79)) ([639c7f1](https://github.com/udondan/avanti/commit/639c7f19d994d8c00a6b3a3064df17f351b0ac94)), closes [#62](https://github.com/udondan/avanti/issues/62)


### Performance Improvements

* cache parsed pulls.jsonl within HistoryManager instance ([#74](https://github.com/udondan/avanti/issues/74)) ([3ec9818](https://github.com/udondan/avanti/commit/3ec981822d10dad4651533cb9c9c2c49301051b8)), closes [#67](https://github.com/udondan/avanti/issues/67)
* eliminate duplicate GitHub API call per file fetch ([#75](https://github.com/udondan/avanti/issues/75)) ([1f5cbf7](https://github.com/udondan/avanti/commit/1f5cbf7dd284f3353a121e643f81c720267d8468))

## [0.12.0](https://github.com/udondan/avanti/compare/v0.11.0...v0.12.0) (2026-05-08)


### Features

* merge local directory files into a single target file ([#50](https://github.com/udondan/avanti/issues/50)) ([e715ddc](https://github.com/udondan/avanti/commit/e715ddc20312edd14d682dd22803f1c1b7bf0029))

## [0.11.0](https://github.com/udondan/avanti/compare/v0.10.0...v0.11.0) (2026-05-08)


### Features

* re-evaluate config in-memory when avanti updates its own config file ([#46](https://github.com/udondan/avanti/issues/46)) ([45b7abc](https://github.com/udondan/avanti/commit/45b7abce78ad48a4f16c4100a1b63c2acb5269d5))

## [0.10.0](https://github.com/udondan/avanti/compare/v0.9.0...v0.10.0) (2026-05-08)


### Features

* add YAML merge with comment preservation ([#44](https://github.com/udondan/avanti/issues/44)) ([e6b9650](https://github.com/udondan/avanti/commit/e6b96504c7a78bd4952ad6f491fb39de7bdf7cc1))

## [0.9.0](https://github.com/udondan/avanti/compare/v0.8.1...v0.9.0) (2026-05-08)


### Features

* add Bitbucket, git, S3, and Vault source types ([#42](https://github.com/udondan/avanti/issues/42)) ([73e43a0](https://github.com/udondan/avanti/commit/73e43a03992019451cb7c995da6050762e3a708c))

## [0.8.1](https://github.com/udondan/avanti/compare/v0.8.0...v0.8.1) (2026-05-08)


### Bug Fixes

* strip [@ref](https://github.com/ref) from remote config spec used as history key ([#40](https://github.com/udondan/avanti/issues/40)) ([412dffb](https://github.com/udondan/avanti/commit/412dffb099171013532c80613b47bd76d820cf78))

## [0.8.0](https://github.com/udondan/avanti/compare/v0.7.0...v0.8.0) (2026-05-08)


### Features

* support remote config files via --config ([#38](https://github.com/udondan/avanti/issues/38)) ([559be5d](https://github.com/udondan/avanti/commit/559be5d1e9536d3975194626c9cb23b84be33e2a))

## [0.7.0](https://github.com/udondan/avanti/compare/v0.6.0...v0.7.0) (2026-05-08)


### Features

* **json:** auto-detect JSON merge for .json/.jsonc sources ([#32](https://github.com/udondan/avanti/issues/32)) ([86bfde9](https://github.com/udondan/avanti/commit/86bfde9911cbc0cb2c02153aa7541b670fc3ed4c))

## [0.6.0](https://github.com/udondan/avanti/compare/v0.5.0...v0.6.0) (2026-05-08)


### Features

* **history:** add pull history, versioning, and restore commands ([#30](https://github.com/udondan/avanti/issues/30)) ([c46bf83](https://github.com/udondan/avanti/commit/c46bf835e9b55cb28ed802ef8c758e65d46352a2))
* **json:** add JSONC support with comment preservation ([#28](https://github.com/udondan/avanti/issues/28)) ([5da8c4d](https://github.com/udondan/avanti/commit/5da8c4d48660c587e6ffe1aac7c4454f9af960f7))

## [0.5.0](https://github.com/udondan/avanti/compare/v0.4.0...v0.5.0) (2026-05-07)


### Features

* **fetch:** add exponential backoff retry for all HTTP requests ([#27](https://github.com/udondan/avanti/issues/27)) ([2caf0f3](https://github.com/udondan/avanti/commit/2caf0f3dc368fd6a7cead8a2946dc4504693d6f1))
* **sources:** replace mandatory CLI tools with native HTTP for GitHub and GitLab ([#21](https://github.com/udondan/avanti/issues/21)) ([990b8ee](https://github.com/udondan/avanti/commit/990b8eedc60047d9743eb69358d0967852c8d9a2))


### Performance Improvements

* parallelize directory file fetches for GitHub and GitLab ([#26](https://github.com/udondan/avanti/issues/26)) ([c11d2e2](https://github.com/udondan/avanti/commit/c11d2e25871eccf75398cf11eb6b315db7c7a16b))

## [0.4.0](https://github.com/udondan/avanti/compare/v0.3.2...v0.4.0) (2026-05-07)


### Features

* **json:** add JSON merge and pretty-print processor ([#19](https://github.com/udondan/avanti/issues/19)) ([6fab171](https://github.com/udondan/avanti/commit/6fab171e1d1b85e86060213f6f0be6b9606ca96f))

## [0.3.2](https://github.com/udondan/avanti/compare/v0.3.1...v0.3.2) (2026-05-07)


### Bug Fixes

* **sources:** fix GitLab pagination, add archive fast path, and explicit directory detection ([#17](https://github.com/udondan/avanti/issues/17)) ([5b348ef](https://github.com/udondan/avanti/commit/5b348ef68b0ba9caebebd5ec6668fd9b07d4eafe))

## [0.3.1](https://github.com/udondan/avanti/compare/v0.3.0...v0.3.1) (2026-05-07)


### Bug Fixes

* read CLI version dynamically from package.json ([#14](https://github.com/udondan/avanti/issues/14)) ([8ccbb80](https://github.com/udondan/avanti/commit/8ccbb80aeea645a50439ddc41693fd20931ad860))

## [0.3.0](https://github.com/udondan/avanti/compare/v0.2.1...v0.3.0) (2026-05-07)


### Features

* add inline raw source content ([#7](https://github.com/udondan/avanti/issues/7)) ([dd46cba](https://github.com/udondan/avanti/commit/dd46cba2a8a79f2882847a7da3beaf5ae002b799))
* add variables and env var support ([#10](https://github.com/udondan/avanti/issues/10)) ([c5eea93](https://github.com/udondan/avanti/commit/c5eea9374d3fb3aeeb6413e6bf6aecfe825465b4))
* add working directory constraint and -w/--working-dir flag ([#9](https://github.com/udondan/avanti/issues/9)) ([5cc731e](https://github.com/udondan/avanti/commit/5cc731e223e4dca893f26f64158f2377c077cbe8))
* resolve variables in target path ([#12](https://github.com/udondan/avanti/issues/12)) ([9aa64fb](https://github.com/udondan/avanti/commit/9aa64fb121ad5a9a052df5ac2afa096fcf1f728a))

## [0.2.1](https://github.com/udondan/avanti/compare/v0.2.0...v0.2.1) (2026-05-07)


### Bug Fixes

* add repository url to package.json ([#5](https://github.com/udondan/avanti/issues/5)) ([842c843](https://github.com/udondan/avanti/commit/842c843f433243b1ef131f0e9192e10fb7816e98))

## [0.2.0](https://github.com/udondan/avanti/compare/v0.1.0...v0.2.0) (2026-05-07)


### Features

* initial implementation ([#1](https://github.com/udondan/avanti/issues/1)) ([a97bbfa](https://github.com/udondan/avanti/commit/a97bbfa0fb07b9bb0dc6518bf8345aaf789bf09f))
