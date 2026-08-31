# Changelog

## [1.3.0](https://github.com/markbang/cohub-mobile/compare/v1.2.1...v1.3.0) (2026-08-31)


### Features

* **mobile:** align Chat workflow with Web ([#30](https://github.com/markbang/cohub-mobile/issues/30)) ([cf9bbae](https://github.com/markbang/cohub-mobile/commit/cf9bbae8c315a966749e6b6af3b1e3f4f7f09e49))


### CI

* bump actions/checkout from 4 to 7 ([#1](https://github.com/markbang/cohub-mobile/issues/1)) ([8dcb5bc](https://github.com/markbang/cohub-mobile/commit/8dcb5bc07055e469d08cb6b08a2a58416646545d))
* bump actions/dependency-review-action from 4 to 5 ([#4](https://github.com/markbang/cohub-mobile/issues/4)) ([be70655](https://github.com/markbang/cohub-mobile/commit/be70655618d52a214516ce48b98cf70781ff2212))
* bump actions/setup-node from 4 to 7 ([#3](https://github.com/markbang/cohub-mobile/issues/3)) ([62a6e36](https://github.com/markbang/cohub-mobile/commit/62a6e36df6ed49c3b2cd6b59f80d09002205fa88))
* bump actions/upload-artifact from 4 to 7 ([#2](https://github.com/markbang/cohub-mobile/issues/2)) ([9301c0d](https://github.com/markbang/cohub-mobile/commit/9301c0dcb7c2b108e129146067b85fdfe7ee4a13))
* bump googleapis/release-please-action from 4 to 5 ([#5](https://github.com/markbang/cohub-mobile/issues/5)) ([a1bca44](https://github.com/markbang/cohub-mobile/commit/a1bca446fecb1d7a15dc1c873a71b04c252f8db9))

## [1.2.1](https://github.com/markbang/cohub-mobile/compare/v1.2.0...v1.2.1) (2026-08-31)


### Fixes

* resolve mobile runtime issues ([f7e6d25](https://github.com/markbang/cohub-mobile/commit/f7e6d25d9965d9e819d362ee103a94d0fd9e6e5b))

## [1.2.0](https://github.com/markbang/cohub-mobile/compare/v1.1.0...v1.2.0) (2026-08-30)


### Features

* refine mobile navigation and controls ([5dfdd4c](https://github.com/markbang/cohub-mobile/commit/5dfdd4cf9390d2e7136ec21f17b0a1867d853e9e))


### Fixes

* improve mobile data loading and ux ([9db55b8](https://github.com/markbang/cohub-mobile/commit/9db55b86f8a6377a8e6782201264530529d8b7fe))
* limit distributed apk to arm64 ([#18](https://github.com/markbang/cohub-mobile/issues/18)) ([eedea23](https://github.com/markbang/cohub-mobile/commit/eedea23cd6114633e0a61c1b83865e5f3a1ecb33))
* publish separate Android ABI APKs ([#19](https://github.com/markbang/cohub-mobile/issues/19)) ([0195192](https://github.com/markbang/cohub-mobile/commit/0195192fc359f6c1529b37c372631a9a9c761abc))
* publish standalone Android APKs ([#20](https://github.com/markbang/cohub-mobile/issues/20)) ([976248b](https://github.com/markbang/cohub-mobile/commit/976248b83fbcca7b133e4d7abe8e5da9e8716170))


### CI

* formalize Android distribution builds ([#21](https://github.com/markbang/cohub-mobile/issues/21)) ([b960d24](https://github.com/markbang/cohub-mobile/commit/b960d241b40abc9ab7f1a7518142d05e695c6581))
* publish Android APK with releases ([#16](https://github.com/markbang/cohub-mobile/issues/16)) ([a25fa31](https://github.com/markbang/cohub-mobile/commit/a25fa31cfc45acb4b58d6d585ca10b1136934e78))

## [1.1.0](https://github.com/markbang/cohub-mobile/compare/v1.0.0...v1.1.0) (2026-08-27)


### Features

* build native Cohub mobile client ([893fb23](https://github.com/markbang/cohub-mobile/commit/893fb23c343973ed1b9b5c60444ef95e46157396))


### Fixes

* override vulnerable uuid dependency ([#13](https://github.com/markbang/cohub-mobile/issues/13)) ([91e2278](https://github.com/markbang/cohub-mobile/commit/91e2278725fbf9f024aa242c64ffa231ee1ee0f4))


### Documentation

* let release tooling own changelog header ([1815451](https://github.com/markbang/cohub-mobile/commit/181545135b93b1c6457965ec5a828d3b45ff3e1b))
* normalize changelog seed ([602e89c](https://github.com/markbang/cohub-mobile/commit/602e89cbd8a7b159d84e1e9a4535e45294420e5b))


### CI

* add mobile CI and release automation ([a17e755](https://github.com/markbang/cohub-mobile/commit/a17e7559a0259e2729d9a22c44aa5a26ef32e7b1))
* gate automatic native releases ([#15](https://github.com/markbang/cohub-mobile/issues/15)) ([becdf50](https://github.com/markbang/cohub-mobile/commit/becdf5012315483e22013cb08e4c6f7a233cd210))
* replace EAS builds with GitHub native builds ([#14](https://github.com/markbang/cohub-mobile/issues/14)) ([41890d9](https://github.com/markbang/cohub-mobile/commit/41890d9c029b6f96182aa44117d0869401985956))
