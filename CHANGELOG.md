# Changelog

## [0.28.0](https://github.com/udondan/avanti/compare/v0.27.1...v0.28.0) (2026-06-24)


### Features

* **sudo:** collapse all privileged writes into a single sudo invocation ([#288](https://github.com/udondan/avanti/issues/288)) ([e5d39b0](https://github.com/udondan/avanti/commit/e5d39b0f4467b15490187c0bb08342d19c4dd0f6))


### Bug Fixes

* **sudo:** record partial history on mid-batch write failure ([#307](https://github.com/udondan/avanti/issues/307)) ([8a352b5](https://github.com/udondan/avanti/commit/8a352b5b68ae1992e2b8dd2a08dd3a058f01ffac))

## [0.27.1](https://github.com/udondan/avanti/compare/v0.27.0...v0.27.1) (2026-06-18)


### Bug Fixes

* **paths:** allow absolute target paths within the working directory ([#286](https://github.com/udondan/avanti/issues/286)) ([26b6d8b](https://github.com/udondan/avanti/commit/26b6d8b422429b818512effb4fb5a20b981f470a))
* **revert:** delete re-created files when undoing last pull ([#287](https://github.com/udondan/avanti/issues/287)) ([61da11b](https://github.com/udondan/avanti/commit/61da11be332e365a5fcd1c3e00480a6b00e0df2a))
* **sudo:** eliminate repeated password prompts for system-path writes ([#284](https://github.com/udondan/avanti/issues/284)) ([84d2f28](https://github.com/udondan/avanti/commit/84d2f28d773daaf6012834be457b7a297df94645))

## [0.27.0](https://github.com/udondan/avanti/compare/v0.26.5...v0.27.0) (2026-06-17)


### Features

* **filter:** glob wildcards + pre-filter GitLab release assets before download ([#281](https://github.com/udondan/avanti/issues/281)) ([96e90af](https://github.com/udondan/avanti/commit/96e90af82f2eaaa2091083eb55680107bf3627e6))

## [0.26.5](https://github.com/udondan/avanti/compare/v0.26.4...v0.26.5) (2026-06-17)


### Bug Fixes

* **gitlab:** rewrite upload URLs to API path to avoid auth-dropping redirect ([#279](https://github.com/udondan/avanti/issues/279)) ([8ca1ced](https://github.com/udondan/avanti/commit/8ca1cedf30f8f418816e7124d27fbfc95311e6ca))

## [0.26.4](https://github.com/udondan/avanti/compare/v0.26.3...v0.26.4) (2026-06-17)


### Bug Fixes

* **gitlab:** check stdout+stderr for token and add hostname fallback in resolveToken ([#277](https://github.com/udondan/avanti/issues/277)) ([87e1471](https://github.com/udondan/avanti/commit/87e14719b5fbdd1526560981a65c9867296f93ad))

## [0.26.3](https://github.com/udondan/avanti/compare/v0.26.2...v0.26.3) (2026-06-16)


### Bug Fixes

* **gitlab:** resolve token from glab stored credentials for CLI release downloads ([#275](https://github.com/udondan/avanti/issues/275)) ([e9dc7db](https://github.com/udondan/avanti/commit/e9dc7dbaf6c5132686d32eb7238060cb4dd0bbc2))

## [0.26.2](https://github.com/udondan/avanti/compare/v0.26.1...v0.26.2) (2026-06-16)


### Bug Fixes

* **gitlab:** use direct_asset_url for release asset downloads ([#273](https://github.com/udondan/avanti/issues/273)) ([c62c3a0](https://github.com/udondan/avanti/commit/c62c3a02dca60833234b768c913f80f3b907f962))

## [0.26.1](https://github.com/udondan/avanti/compare/v0.26.0...v0.26.1) (2026-06-15)


### Bug Fixes

* **github:** include GitHub API error message in HTTP error output ([#269](https://github.com/udondan/avanti/issues/269)) ([7c0ed3f](https://github.com/udondan/avanti/commit/7c0ed3fe89fa35653322545ee016f68f82459c68))

## [0.26.0](https://github.com/udondan/avanti/compare/v0.25.0...v0.26.0) (2026-06-01)


### Features

* resolve relative source paths relative to config file location ([#244](https://github.com/udondan/avanti/issues/244)) ([3bde566](https://github.com/udondan/avanti/commit/3bde5669dc97f01c2c12b9c9daa8d6fdadd72ff4))

## [0.25.0](https://github.com/udondan/avanti/compare/v0.24.0...v0.25.0) (2026-05-26)


### ⚠ BREAKING CHANGES

* `post:` is removed; migrate to `on.write:`.

### Features

* add $os, $arch, $arch_go system-injected variables ([#206](https://github.com/udondan/avanti/issues/206)) ([bee76c6](https://github.com/udondan/avanti/commit/bee76c6c7c0d7e035cfc270a46d7ef7f73bbf802))
* add extract option for unpacking archives from single-file sources ([#210](https://github.com/udondan/avanti/issues/210)) ([4159785](https://github.com/udondan/avanti/commit/41597857ba0bd0c7c6ebd7b5c80cdf9bd541bd86))
* add filter option for directory and release sources ([#204](https://github.com/udondan/avanti/issues/204)) ([a69d706](https://github.com/udondan/avanti/commit/a69d706b12273fc19b012304c45f0bc0a1ed809a))
* add followSymlink option to update symlink target content ([#209](https://github.com/udondan/avanti/issues/209)) ([5b2e67f](https://github.com/udondan/avanti/commit/5b2e67f62e350b6f7a4b2188cc4cf67173c57f8b))
* add sudo option for writing to privileged file locations ([#215](https://github.com/udondan/avanti/issues/215)) ([862c0f8](https://github.com/udondan/avanti/commit/862c0f8a1be0e2c671fa9b0e8620ec52440ad45c))
* **condition:** accept darwin and win32 as os condition values ([#232](https://github.com/udondan/avanti/issues/232)) ([80a3312](https://github.com/udondan/avanti/commit/80a331290b00254ac07cfd716686089f63f121f5))
* **ini:** add INI deep merge with comment and key-order preservation ([#233](https://github.com/udondan/avanti/issues/233)) ([dc6a0fe](https://github.com/udondan/avanti/commit/dc6a0fee57084289520232547a480f7b37333d11))
* normalize $latest to semver, add $recent and /pattern/ ref syntax ([#208](https://github.com/udondan/avanti/issues/208)) ([8c1506c](https://github.com/udondan/avanti/commit/8c1506cfd629f769de1e049eaff5ec5067c056f4))
* replace post with on: event system ([#216](https://github.com/udondan/avanti/issues/216)) ([50bdcab](https://github.com/udondan/avanti/commit/50bdcab6e76911fb7c2752e15c89f515c6ed812e))
* **symlink:** create filesystem symlinks instead of copying content ([#236](https://github.com/udondan/avanti/issues/236)) ([22db27a](https://github.com/udondan/avanti/commit/22db27afeec2445c383cda5d4a0ac9cefc136f1b))


### Bug Fixes

* expand tilde in --working-dir flag ([#205](https://github.com/udondan/avanti/issues/205)) ([cfcc5b8](https://github.com/udondan/avanti/commit/cfcc5b84ee8adfaa6e5b6d7dcf478b2aebbd6aa8))
* **json:** preserve property order when insert-mode key is updated ([#217](https://github.com/udondan/avanti/issues/217)) ([6bad6e0](https://github.com/udondan/avanti/commit/6bad6e039116e281a02f65fdc819c4a822717fe2))
* preserve YAML key order in insert mode when value is updated ([#228](https://github.com/udondan/avanti/issues/228)) ([5ed56e6](https://github.com/udondan/avanti/commit/5ed56e610c79d32a53d04826ba29d7011f1e19d8)), closes [#218](https://github.com/udondan/avanti/issues/218)
* **toml:** preserve property order when insert-mode key is updated ([#227](https://github.com/udondan/avanti/issues/227)) ([eed9301](https://github.com/udondan/avanti/commit/eed9301a08a2ce7ef5d41f517e48b3d44a7c7d54))

## [0.24.0](https://github.com/udondan/avanti/compare/v0.23.1...v0.24.0) (2026-05-21)


### Features

* add list/object variable values and ${expr} nested access syntax ([#195](https://github.com/udondan/avanti/issues/195)) ([74efb6f](https://github.com/udondan/avanti/commit/74efb6f7853a6c38259455743471f87295e55741))
* add release artifact downloading for GitHub and GitLab ([#198](https://github.com/udondan/avanti/issues/198)) ([bb5c48f](https://github.com/udondan/avanti/commit/bb5c48f84b80a0abb28efe1b61d90602af33f491))
* add writeInPlace option to preserve inode on pull ([#193](https://github.com/udondan/avanti/issues/193)) ([f472dfa](https://github.com/udondan/avanti/commit/f472dfa644e1ea31f642ba0a7ba6397cb2d7a480))


### Bug Fixes

* **deps:** update dependency @aws-sdk/client-s3 to v3.1049.0 ([#201](https://github.com/udondan/avanti/issues/201)) ([713866f](https://github.com/udondan/avanti/commit/713866f3b0d8b82419898a5b4cecf82468865e9e))
* detect and apply mode-only changes; accept numeric mode in config ([#197](https://github.com/udondan/avanti/issues/197)) ([b8d77be](https://github.com/udondan/avanti/commit/b8d77beefb6555ec6d0c9b13ce20d723c9def412))

## [0.23.1](https://github.com/udondan/avanti/compare/v0.23.0...v0.23.1) (2026-05-20)


### Bug Fixes

* avanti log finds history when pull used a remote --config ([#192](https://github.com/udondan/avanti/issues/192)) ([8b8ee21](https://github.com/udondan/avanti/commit/8b8ee2122ab9c0e961ee50ad922120fe75b187ca))
* enforce working-directory boundary for ~/ target paths ([#190](https://github.com/udondan/avanti/issues/190)) ([f4cca4d](https://github.com/udondan/avanti/commit/f4cca4d762bff4746d3ae055da0d0b6de39a4be0))

## [0.23.0](https://github.com/udondan/avanti/compare/v0.22.0...v0.23.0) (2026-05-20)


### Features

* add backup field with per-file path variables and counter pattern ([#188](https://github.com/udondan/avanti/issues/188)) ([a2b53f3](https://github.com/udondan/avanti/commit/a2b53f31457f7a7656f5cb0f96e93fb2feb968b5))
* allow target_exists: false as direct condition ([#185](https://github.com/udondan/avanti/issues/185)) ([944efc4](https://github.com/udondan/avanti/commit/944efc4af71c6e07245849396e7ed1adfe8e16ea))
* support brace expansion in files target keys ([#189](https://github.com/udondan/avanti/issues/189)) ([010c982](https://github.com/udondan/avanti/commit/010c982112388a9e7ff991ddf40adb41e2fb2737))

## [0.22.0](https://github.com/udondan/avanti/compare/v0.21.2...v0.22.0) (2026-05-19)


### Features

* add dedupe array strategy for JSON/YAML/TOML merge processors ([#182](https://github.com/udondan/avanti/issues/182)) ([da4fdb4](https://github.com/udondan/avanti/commit/da4fdb4f7336b7f8b5946c8894f4dad7c73bb8b1))
* add template rendering processor ([#184](https://github.com/udondan/avanti/issues/184)) ([9a0527d](https://github.com/udondan/avanti/commit/9a0527dbd8d4948dfa767f43536c8d81d327890b))
* support $self as a variable inside file entries ([#178](https://github.com/udondan/avanti/issues/178)) ([e56bed2](https://github.com/udondan/avanti/commit/e56bed2e4d0c339008be955d2b77afc25cb58b83))
* use pending write content when a target is also a local source ([#183](https://github.com/udondan/avanti/issues/183)) ([00f0fbb](https://github.com/udondan/avanti/commit/00f0fbb674403674d8b1372f7e5c9180f46526d4))


### Bug Fixes

* reject unknown keys in json/yaml/toml merge option blocks ([#180](https://github.com/udondan/avanti/issues/180)) ([a990a7a](https://github.com/udondan/avanti/commit/a990a7a4082eff8c7b7245b395d6c5e70c7773ce))

## [0.21.2](https://github.com/udondan/avanti/compare/v0.21.1...v0.21.2) (2026-05-19)


### Bug Fixes

* **deps:** update aws-sdk-js-v3 monorepo to v3.1047.0 ([#172](https://github.com/udondan/avanti/issues/172)) ([3dc8a80](https://github.com/udondan/avanti/commit/3dc8a808469d33832e713b5423a8ea62c4ad7226))
* **deps:** update aws-sdk-js-v3 monorepo to v3.1048.0 ([#176](https://github.com/udondan/avanti/issues/176)) ([105e01b](https://github.com/udondan/avanti/commit/105e01bf51853a71507f7b78270084da84f1e00e))
* ensure merged JSON/YAML/TOML files end with a trailing newline ([#175](https://github.com/udondan/avanti/issues/175)) ([97b55c5](https://github.com/udondan/avanti/commit/97b55c5bff72c93ad4c204073efe77fca8871fbb))

## [0.21.1](https://github.com/udondan/avanti/compare/v0.21.0...v0.21.1) (2026-05-18)


### Bug Fixes

* **deps:** update aws-sdk-js-v3 monorepo to v3.1046.0 ([#168](https://github.com/udondan/avanti/issues/168)) ([744239a](https://github.com/udondan/avanti/commit/744239a38b0b177601805584d704b1793f3a3052))
* remove deprecated Bitbucket App Password auth and improve test coverage ([#163](https://github.com/udondan/avanti/issues/163)) ([efa4c99](https://github.com/udondan/avanti/commit/efa4c99143cfa702a30545a00d80c8a6b0a1c512))

## [0.21.0](https://github.com/udondan/avanti/compare/v0.20.0...v0.21.0) (2026-05-14)


### Features

* add conditional file/source writing with if and ifAny ([#155](https://github.com/udondan/avanti/issues/155)) ([e67e2ab](https://github.com/udondan/avanti/commit/e67e2ab26044fa16627bbb7f0739cd82aef33166))


### Bug Fixes

* **deps:** update dependency yaml to v2.9.0 ([#159](https://github.com/udondan/avanti/issues/159)) ([189c4b5](https://github.com/udondan/avanti/commit/189c4b5e99a19b05e38ef69e4461b6da06c00bff))

## [0.20.0](https://github.com/udondan/avanti/compare/v0.19.1...v0.20.0) (2026-05-13)


### Features

* add aws_secrets_manager and aws_systems_manager_parameter sources, rename s3 to aws_s3 ([#152](https://github.com/udondan/avanti/issues/152)) ([85defb4](https://github.com/udondan/avanti/commit/85defb47430ecda9ba57b5c877f3e988d4c15a15))
* add JSON formatting options (indent, trailing_commas, sort_keys, minify, strip_comments) ([#154](https://github.com/udondan/avanti/issues/154)) ([5e9c50a](https://github.com/udondan/avanti/commit/5e9c50a2f7014e0e2d7e8a2b520079ddbaceec9d))
* replace aws CLI shell-out with @aws-sdk/client-s3 SDK ([#150](https://github.com/udondan/avanti/issues/150)) ([4252cfa](https://github.com/udondan/avanti/commit/4252cfad7e8045f3a0e61d0b634d0f04d744ef83))
* variables support remote sources with sequential evaluation ([#153](https://github.com/udondan/avanti/issues/153)) ([678185e](https://github.com/udondan/avanti/commit/678185e12213f7663177ac63fd4d30750f5fab5d))

## [0.19.1](https://github.com/udondan/avanti/compare/v0.19.0...v0.19.1) (2026-05-12)


### Bug Fixes

* expand ~/ in target paths to home directory ([#148](https://github.com/udondan/avanti/issues/148)) ([0558967](https://github.com/udondan/avanti/commit/055896748bf7ecf634ced09e61203af6d116224d))

## [0.19.0](https://github.com/udondan/avanti/compare/v0.18.0...v0.19.0) (2026-05-12)


### Features

* add --via flag to control transport for remote --config fetches ([#146](https://github.com/udondan/avanti/issues/146)) ([b2d5d94](https://github.com/udondan/avanti/commit/b2d5d9438cb85b5ea250429a959643a1c2410258))

## [0.18.0](https://github.com/udondan/avanti/compare/v0.17.1...v0.18.0) (2026-05-12)


### Features

* add via option to gitlab/github sources to control transport ([#145](https://github.com/udondan/avanti/issues/145)) ([56283fc](https://github.com/udondan/avanti/commit/56283fc1bd8ee56b489e776e915062aeaccac334))


### Bug Fixes

* **gitlab:** surface glab errors when hostname is configured and log glab results ([#143](https://github.com/udondan/avanti/issues/143)) ([e078f75](https://github.com/udondan/avanti/commit/e078f7587ea543ec62bd0ff20dc6f2a8b7913a09))

## [0.17.1](https://github.com/udondan/avanti/compare/v0.17.0...v0.17.1) (2026-05-12)


### Bug Fixes

* **gitlab:** fall back to glab CLI on network-level fetch errors ([#140](https://github.com/udondan/avanti/issues/140)) ([a09fd35](https://github.com/udondan/avanti/commit/a09fd35170a47a367465a9b7b0658be99c485894))
* **verbose:** include network error reason in verbose output ([#142](https://github.com/udondan/avanti/issues/142)) ([da70f4e](https://github.com/udondan/avanti/commit/da70f4ea6cd6c2e12129ff6b13542120deb79f7c))

## [0.17.0](https://github.com/udondan/avanti/compare/v0.16.0...v0.17.0) (2026-05-12)


### Features

* add --verbose flag for debugging remote requests ([#139](https://github.com/udondan/avanti/issues/139)) ([73f1634](https://github.com/udondan/avanti/commit/73f16345f4ec982ed44948f9de12c31d98329427))
* add git+ssh:// URL support for sources and config loading ([#137](https://github.com/udondan/avanti/issues/137)) ([4843323](https://github.com/udondan/avanti/commit/4843323a74f9acad09b8f47119a4a129bc82f32e))

## [0.16.0](https://github.com/udondan/avanti/compare/v0.15.0...v0.16.0) (2026-05-11)


### Features

* add binary file support ([#136](https://github.com/udondan/avanti/issues/136)) ([25af9b6](https://github.com/udondan/avanti/commit/25af9b657d877131fcecc11a54f8cc02275d5f6c))
* add host parameter to gitlab, github, and bitbucket sources ([#135](https://github.com/udondan/avanti/issues/135)) ([fa5d4ac](https://github.com/udondan/avanti/commit/fa5d4ac406b82c7530dda003daa19c40f8ead04e))
* add TOML deep merge support ([#133](https://github.com/udondan/avanti/issues/133)) ([8b08d5b](https://github.com/udondan/avanti/commit/8b08d5bbaa4892f5f0715e3b82f34b8d6d97aa85))

## [0.15.0](https://github.com/udondan/avanti/compare/v0.14.0...v0.15.0) (2026-05-11)


### Features

* add Windows compatibility ([#131](https://github.com/udondan/avanti/issues/131)) ([70f44fb](https://github.com/udondan/avanti/commit/70f44fb50ab344320c794ede35e5be9ca3ac616a))

## [0.14.0](https://github.com/udondan/avanti/compare/v0.13.0...v0.14.0) (2026-05-11)


### ⚠ BREAKING CHANGES

* **config:** old list format is no longer supported.

### Features

* **config:** add $self key for composable remote configs ([#101](https://github.com/udondan/avanti/issues/101)) ([beef834](https://github.com/udondan/avanti/commit/beef834544a2b53017fbcd49d7a696bf68169722))
* **config:** change files format from list to map ([#93](https://github.com/udondan/avanti/issues/93)) ([157bafc](https://github.com/udondan/avanti/commit/157bafce525d5ae7ed14a86681a4e9abf6caf382))
* **sources:** add path/url source types with optional flag ([#100](https://github.com/udondan/avanti/issues/100)) ([625d89a](https://github.com/udondan/avanti/commit/625d89a81dbbdf650408f06375f30610b6290bae))


### Bug Fixes

* **cache:** always create fetch cache regardless of $self usage ([#105](https://github.com/udondan/avanti/issues/105)) ([0d7d2e9](https://github.com/udondan/avanti/commit/0d7d2e9efb21ccbde574087c017be21bf2396d2f))
* **deps:** update dependency chalk to v5.6.2 ([#119](https://github.com/udondan/avanti/issues/119)) ([67487db](https://github.com/udondan/avanti/commit/67487db866cf3ca2d5d54b169d6a2234613022b7))
* **deps:** update dependency commander to v14 ([#124](https://github.com/udondan/avanti/issues/124)) ([cf36de7](https://github.com/udondan/avanti/commit/cf36de779c73e7264e3b1798307e74eb6c8470c7))
* **deps:** update dependency diff to v9 ([#125](https://github.com/udondan/avanti/issues/125)) ([9259afd](https://github.com/udondan/avanti/commit/9259afd27b8ba0e10aa6abda3ad47df4fbab0667))
* **renovate:** enable auto mode and update deprecated fileMatch ([#107](https://github.com/udondan/avanti/issues/107)) ([664cd99](https://github.com/udondan/avanti/commit/664cd99d830b23877773ef6923f8e7c13c650058))
* **renovate:** limit to 1 concurrent PR to prevent rebase conflicts ([#113](https://github.com/udondan/avanti/issues/113)) ([7d29cec](https://github.com/udondan/avanti/commit/7d29cec84c4c324dae70244d89b009049ed13413))
* **renovate:** rebase PRs when behind base branch ([#127](https://github.com/udondan/avanti/issues/127)) ([719aa96](https://github.com/udondan/avanti/commit/719aa96d2ca1847551f95971a610ecfaf12a846a))
* **tests:** eliminate temp-dir count race in writer.test.ts ([#104](https://github.com/udondan/avanti/issues/104)) ([e2058c7](https://github.com/udondan/avanti/commit/e2058c7657f712af7030c28b8c52386835be3448)), closes [#89](https://github.com/udondan/avanti/issues/89)
* **tests:** resolve TS errors and add tsc to pre-commit hook ([#103](https://github.com/udondan/avanti/issues/103)) ([d3517d2](https://github.com/udondan/avanti/commit/d3517d2ff8203ef7db25b8d6ba96f2e13e069dbd))

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
