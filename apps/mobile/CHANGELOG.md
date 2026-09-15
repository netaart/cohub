# Changelog

## [2.2.12](https://github.com/markbang/cohub-mobile/compare/v2.2.11...v2.2.12) (2026-09-15)


### Features

* **android:** download in-app APKs from Yaota ([f19f2dc](https://github.com/markbang/cohub-mobile/commit/f19f2dc1ce9899b026d69b66954570093f303993))
* **android:** download in-app APKs from Yaota ([#83](https://github.com/markbang/cohub-mobile/issues/83)) ([7d7b70c](https://github.com/markbang/cohub-mobile/commit/7d7b70c911ce24437203e17d6a30e5b6f0f47ae5))
* **chat:** filter global Chats by source ([2c7bc57](https://github.com/markbang/cohub-mobile/commit/2c7bc57ef943357d37b84f2d7f807f53fbb055b0))
* **chat:** polish message bubble sending flow ([2f13159](https://github.com/markbang/cohub-mobile/commit/2f1315952a518c78bd45419de3d9abee6b1e6f7b))
* **ota:** publish verified binary deltas through Yaota ([e7b2e07](https://github.com/markbang/cohub-mobile/commit/e7b2e07607c2b952d714e1b200b14554ea1314d4))


### Fixes

* **chat:** keep overflowing code-block swipes off the panel ([4187a80](https://github.com/markbang/cohub-mobile/commit/4187a803d7e8271fe73bd48be2efdbdaedf93fb9))
* **chat:** keep overflowing code-block swipes off the panel ([#85](https://github.com/markbang/cohub-mobile/issues/85)) ([a4bd04e](https://github.com/markbang/cohub-mobile/commit/a4bd04e281a090e44bc379a88ebba6f1fb511627))
* **chat:** paint the destination chat on the first open frame ([1482df8](https://github.com/markbang/cohub-mobile/commit/1482df82d19386e227f79b9ca7d66b3ecafb2191))
* **chat:** paint the destination chat on the first open frame ([#92](https://github.com/markbang/cohub-mobile/issues/92)) ([98b3e0f](https://github.com/markbang/cohub-mobile/commit/98b3e0f3c50a42ccc9fef5817e478d07a26d09fe))
* **chat:** stop opening onto the space Chats panel ([bc17649](https://github.com/markbang/cohub-mobile/commit/bc17649e3fe339a44a52e8d1b3d8a605ec678895))
* **chat:** stop opening onto the space Chats panel ([#94](https://github.com/markbang/cohub-mobile/issues/94)) ([b3077c4](https://github.com/markbang/cohub-mobile/commit/b3077c409f773bc209c6300df353583e8e1b6efd))
* **chat:** stop the timeline jittering after opening a Chat ([1126996](https://github.com/markbang/cohub-mobile/commit/1126996b563f6bd40552db6d3c74847ee177fd2a))
* **chat:** stop the timeline jittering after opening a Chat ([#86](https://github.com/markbang/cohub-mobile/issues/86)) ([f0b0bb8](https://github.com/markbang/cohub-mobile/commit/f0b0bb847acd0876acdb9b2976177991a68b44d3))
* **ci:** validate the locked Expo baseline and update SDK 57 patches ([4f62907](https://github.com/markbang/cohub-mobile/commit/4f62907a7c2f717e3246ba264b589b1fa7a82e07))
* **ui:** size action menus to their content ([3a582ed](https://github.com/markbang/cohub-mobile/commit/3a582eddfe78fced6de741478f2b559292e80f8c))


### CI

* copy GitHub Release APKs onto Yaota ([7886d7b](https://github.com/markbang/cohub-mobile/commit/7886d7b30c4991dba55cac06dea4df3a6d89cc78))
* copy GitHub Release APKs onto Yaota ([#89](https://github.com/markbang/cohub-mobile/issues/89)) ([74f2ea3](https://github.com/markbang/cohub-mobile/commit/74f2ea3946c67ceb62f524bf7b286d2c8dad4051))
* drop the Yaota APK GitHub Action ([ab11e33](https://github.com/markbang/cohub-mobile/commit/ab11e33150f250bfc80601699d213d5408087f39))
* drop the Yaota APK GitHub Action ([#90](https://github.com/markbang/cohub-mobile/issues/90)) ([cf6d982](https://github.com/markbang/cohub-mobile/commit/cf6d9825675df10281ae556ab5d03d833a021936))
* parallelize bundles and keep the Gradle caches warm ([#93](https://github.com/markbang/cohub-mobile/issues/93)) ([6d5532e](https://github.com/markbang/cohub-mobile/commit/6d5532e52ada8096430802969fa6c9c3e10ecaac))
* parallelize bundles and key Gradle caches on the lockfile ([cd2ee1a](https://github.com/markbang/cohub-mobile/commit/cd2ee1abb11897c6952ab61ebc630aa7b6ae432d))
* publish tagged Android APKs to Yaota ([4932ce7](https://github.com/markbang/cohub-mobile/commit/4932ce7f50232b69d4f7cbeec50c10b0d51f6600))
* publish tagged Android APKs to Yaota ([#91](https://github.com/markbang/cohub-mobile/issues/91)) ([819be80](https://github.com/markbang/cohub-mobile/commit/819be801c90dc4d72a035960f0b0987509dc903a))
* stop compiling native debug builds on pull requests ([958dfed](https://github.com/markbang/cohub-mobile/commit/958dfed94af4db0bc75d887f9e99f01e8c2030b1))
* stop compiling native debug builds on pull requests ([#88](https://github.com/markbang/cohub-mobile/issues/88)) ([c3e9148](https://github.com/markbang/cohub-mobile/commit/c3e9148cbc820705af1bfdb6ae46925f4d514ed4))

## [2.2.11](https://github.com/markbang/cohub-mobile/compare/v2.2.10...v2.2.11) (2026-09-15)


### Fixes

* **chat:** keep focus scrolling off the LegendList timeline ([1f64d7f](https://github.com/markbang/cohub-mobile/commit/1f64d7f36ba52ae8ab666e8cb1d641c9c711d17e))
* **chat:** keep the tail through bursts and settle the send fly-in ([2e9af1d](https://github.com/markbang/cohub-mobile/commit/2e9af1db5e5809e78b12ae74481738c73c202eb3))
* **chat:** let a code block keep the drag it starts ([e55191c](https://github.com/markbang/cohub-mobile/commit/e55191c2ad9017c1976537f09935c66968fe5249))
* **chat:** let LegendList slide the tail while a bubble grows ([cfa755c](https://github.com/markbang/cohub-mobile/commit/cfa755c5c8054d3dee6a1fc12197c0694446d401))
* **chat:** pace the native streaming text ([7434f2b](https://github.com/markbang/cohub-mobile/commit/7434f2bb73897afdf962c29fa11b74d7f853d33d))
* **chat:** repair attachment upload and native markdown theming ([b62322b](https://github.com/markbang/cohub-mobile/commit/b62322b4a7f02178c27012fe7331d8184a941e01))
* **chat:** stop blocking the panel swipe over messages ([73a5c1b](https://github.com/markbang/cohub-mobile/commit/73a5c1bd02bbe0549d24ce45288899fd10d311da))
* **mobile:** forward external row state to LegendList via extraData ([d5565b7](https://github.com/markbang/cohub-mobile/commit/d5565b7230947aa20077eff91f544d5cb464deaa))


### Performance

* **chat:** de-invert the timeline onto LegendList ([db85278](https://github.com/markbang/cohub-mobile/commit/db852780b62971ff6dc4aa70174ac5c96092dc74))
* **chat:** stream message text through the native Markdown renderer ([4bf01d3](https://github.com/markbang/cohub-mobile/commit/4bf01d370f58e17f81fb37bbe412158d84ecac1b))

## [2.2.10](https://github.com/markbang/cohub-mobile/compare/v2.2.9...v2.2.10) (2026-09-14)


### Features

* **about:** export the diagnostic log locally ([8038431](https://github.com/markbang/cohub-mobile/commit/8038431a4fc57dfe25ee09db85587dd1f8c65075))
* **about:** save the diagnostic log to a folder ([fdb1ac9](https://github.com/markbang/cohub-mobile/commit/fdb1ac918987bf113a30802dc0941753fa2fb752))
* **chat:** incremental Shiki tokenizer for streaming code ([315e447](https://github.com/markbang/cohub-mobile/commit/315e447ac1c684989dca6c58f74b9943c9d38298))
* **chat:** render completed message text with native Markdown ([1e37dd4](https://github.com/markbang/cohub-mobile/commit/1e37dd480313e6725ed63f8443543b7cb651c183))
* sync foreground data automatically ([70a926b](https://github.com/markbang/cohub-mobile/commit/70a926b70e94fe17e9eab9619793779c979e29dc))
* **ui:** add edge-to-edge gradient chrome ([b537084](https://github.com/markbang/cohub-mobile/commit/b5370845a1a386ea2fb2af97fef16d6f828dd174))


### Fixes

* **chat:** reveal streamed text in finer commits ([9d48676](https://github.com/markbang/cohub-mobile/commit/9d486767ae1f7cf1d0a65b2c7a151e97b1719428))
* **tabs:** show refresh indicators only on pull ([39baa2b](https://github.com/markbang/cohub-mobile/commit/39baa2be6ab3d1b053527b1992e88b05e6e8fb74))


### Performance

* **chat:** bound chat-open code work ([309d7be](https://github.com/markbang/cohub-mobile/commit/309d7be42512b9491785c1ebe5a599e130ad7d2b))
* **chat:** cut running-chat entry cost ([1fac4b5](https://github.com/markbang/cohub-mobile/commit/1fac4b59caf3e78a2bc33bffe91c8bb270632406))
* **chat:** pace the streaming tail as plain text ([2d06998](https://github.com/markbang/cohub-mobile/commit/2d06998eb99b5f632490e69002a4b07d92d43cb2))
* **chat:** stabilize message list renders ([c544ec8](https://github.com/markbang/cohub-mobile/commit/c544ec8da98879fb777f9da198569ff881d0cf1f))
* **chat:** trim the chat-open critical path ([2784d5e](https://github.com/markbang/cohub-mobile/commit/2784d5ec656337b9a7b7207434a9f8112f812edc))
* **tabs:** migrate Chats and Spaces lists to LegendList ([0bd4070](https://github.com/markbang/cohub-mobile/commit/0bd407038cd915ab4d8239a7bf6a54169c7cb741))


### Documentation

* **ota:** assess update experience and delivery capabilities ([e1bf841](https://github.com/markbang/cohub-mobile/commit/e1bf841edc625ad6bd1689e1181804a462412480))

## [2.2.9](https://github.com/markbang/cohub-mobile/compare/v2.2.8...v2.2.9) (2026-09-14)


### Fixes

* **android:** disable predictive back gesture ([eb92b75](https://github.com/markbang/cohub-mobile/commit/eb92b75ead7592d110130e2fb18195239bfd0c69))

## [2.2.8](https://github.com/markbang/cohub-mobile/compare/v2.2.7...v2.2.8) (2026-09-14)


### Fixes

* **android:** avoid fragment attach on cancelled back swipe ([b0165e0](https://github.com/markbang/cohub-mobile/commit/b0165e020c516858122d18bfcf2a34da2a9925ac))
* **android:** guard predictive back during screen transitions ([ce3cfa1](https://github.com/markbang/cohub-mobile/commit/ce3cfa16fafd096b8fd89dab2d9928419bc38baf))
* **space:** show collaborator names and prompt sandbox restart ([95195ef](https://github.com/markbang/cohub-mobile/commit/95195efe75f16abe1ca92f84d1d94633cc554e83))

## [2.2.7](https://github.com/markbang/cohub-mobile/compare/v2.2.6...v2.2.7) (2026-09-14)


### Fixes

* **android:** narrow predictive back stack state ([4893e82](https://github.com/markbang/cohub-mobile/commit/4893e82d2d88604eb0e6ffffee128f3aa2325164))

## [2.2.6](https://github.com/markbang/cohub-mobile/compare/v2.2.5...v2.2.6) (2026-09-14)


### Fixes

* **android:** preserve previous screen during back gesture ([a56c452](https://github.com/markbang/cohub-mobile/commit/a56c452f119a01844e7456ef012238484c19d45c))

## [2.2.5](https://github.com/markbang/cohub-mobile/compare/v2.2.4...v2.2.5) (2026-09-14)


### Fixes

* **android:** use supported predictive back callback ([a94e471](https://github.com/markbang/cohub-mobile/commit/a94e471224552fc73b70808d745ec514d650433c))

## [2.2.4](https://github.com/markbang/cohub-mobile/compare/v2.2.3...v2.2.4) (2026-09-14)


### Features

* add space collaborators and invitations ([2fefc7d](https://github.com/markbang/cohub-mobile/commit/2fefc7de1ca8e563860c2b927676c30559e81adf))
* align mobile space and billing workflows ([9020889](https://github.com/markbang/cohub-mobile/commit/90208897d287e08c40c6bb858b94a4124c022971))
* **android:** add predictive back animation ([2c63044](https://github.com/markbang/cohub-mobile/commit/2c630444dc26507375d6acc3cbc7a59fdac2185e))
* polish space controls and task pagination ([3fd8a0b](https://github.com/markbang/cohub-mobile/commit/3fd8a0bdc6a7d41814b5569d6dcb302d6fa6a58b))


### Fixes

* **chat:** avoid replaying send transition on reconcile ([c33fa80](https://github.com/markbang/cohub-mobile/commit/c33fa8053f63db34816a90cbb9682f724334e0bf))
* **chat:** coordinate keyboard dismissal with send ([f929d6c](https://github.com/markbang/cohub-mobile/commit/f929d6c5ed0a28c006180a352cfe524cf64416ea))
* **chat:** keep keyboard focused while sending ([042097f](https://github.com/markbang/cohub-mobile/commit/042097f6e4886fd1fca2805fb3b8cbe8953cf0e4))
* **chat:** keep send bubble footer geometry stable ([34d2cd5](https://github.com/markbang/cohub-mobile/commit/34d2cd51ad2c237655a643835dbdf4cce8e2b6ee))
* **chat:** keep send transition geometry live ([539666e](https://github.com/markbang/cohub-mobile/commit/539666e3df56c8a655eb26c2ae2a9ab19ecf8c7d))
* **chat:** pause tail scrolling during send transition ([a38f3ac](https://github.com/markbang/cohub-mobile/commit/a38f3ac8a09547ef4f8d0b768e17551990482c9e))
* **diagnostics:** capture complete chat send timeline ([7d3c8a7](https://github.com/markbang/cohub-mobile/commit/7d3c8a78400d4172203e61bceb178530c599e6a8))
* keep space workflow checks compatible ([d67738f](https://github.com/markbang/cohub-mobile/commit/d67738f7b7622a5579132ffbb42717a59d059194))

## [2.2.3](https://github.com/markbang/cohub-mobile/compare/v2.2.2...v2.2.3) (2026-09-13)


### Features

* **chat:** animate sent messages from composer ([bdf66fe](https://github.com/markbang/cohub-mobile/commit/bdf66fe7edaa67fdc9e1d71e6fbc80b385cbd768))
* **diagnostics:** add SQLite feedback collection ([0015fee](https://github.com/markbang/cohub-mobile/commit/0015fee5b194e34cdb251b34c0da0d7aff24a162))


### Fixes

* **chat:** animate the optimistic bubble in place ([4685b86](https://github.com/markbang/cohub-mobile/commit/4685b865d8c05393a99f94db55ae0399938bbc68))
* **chat:** animate the rendered optimistic bubble ([fd6ad98](https://github.com/markbang/cohub-mobile/commit/fd6ad98aa8371835aeff104278db5fa4647f28aa))
* **chat:** hand off send bubble to optimistic row ([85f421f](https://github.com/markbang/cohub-mobile/commit/85f421ffb6146248e7051ace1d8ec3fb7b8232d8))
* **chat:** measure send transition after bubble layout ([d52b1f8](https://github.com/markbang/cohub-mobile/commit/d52b1f84eabf841d697f9e5176e84322aa8b4480))
* **chat:** preserve send transition across reconciliation ([a8b497e](https://github.com/markbang/cohub-mobile/commit/a8b497e65f81db72d1b7502ac0609e553870092d))
* **chat:** reshape sent bubble transition ([1f56948](https://github.com/markbang/cohub-mobile/commit/1f569489e40faa86dd46fc73efbec315a781bb80))
* **chat:** size send bubble to message content ([3024990](https://github.com/markbang/cohub-mobile/commit/3024990ab359b1fbc817b94882e5b1addde38450))
* **chat:** stabilize runtime status bubble layout ([8af1fbf](https://github.com/markbang/cohub-mobile/commit/8af1fbf7c2303ff5100fddae9399c41d5cc9b4bc))

## [2.2.2](https://github.com/markbang/cohub-mobile/compare/v2.2.1...v2.2.2) (2026-09-13)


### Fixes

* **chat:** remove message long press and image flash ([498867e](https://github.com/markbang/cohub-mobile/commit/498867e4036f624175d8bdc361011f23eb2ae0c8))
* **chat:** settle optimistic message state ([2e5d6bf](https://github.com/markbang/cohub-mobile/commit/2e5d6bf8100557f46e3407b1a0a8b840f324fb7f))
* **image-viewer:** restore stable Android rendering ([4af642f](https://github.com/markbang/cohub-mobile/commit/4af642f3879a81fc9b3823d32c6ddef286b19050))
* **navigation:** disable crashing experimental stack ([6348cf1](https://github.com/markbang/cohub-mobile/commit/6348cf1214cd2970596cbbdb3b68240ac3cd0ea3))

## [2.2.1](https://github.com/markbang/cohub-mobile/compare/v2.2.0...v2.2.1) (2026-09-13)


### Features

* **activity:** add token heatmap, task results, and recent work ([92baf5f](https://github.com/markbang/cohub-mobile/commit/92baf5fc8ad6ca305ce6c459496883df89ee4826))
* **mobile:** unify bubble layout and update release automation ([79ac9d2](https://github.com/markbang/cohub-mobile/commit/79ac9d2d5d797867ff5b132ee25b63a2692e123a))
* **native:** add platform navigation and browser preferences ([d7dc3f4](https://github.com/markbang/cohub-mobile/commit/d7dc3f412306cbf789162952bed216709d861af6))
* **settings:** redesign settings navigation and channel management ([f402520](https://github.com/markbang/cohub-mobile/commit/f402520a9bbceac80d2b73916e5e3b22e3660dff))
* **ui:** unify app navigation and anchored action menus ([15a00a6](https://github.com/markbang/cohub-mobile/commit/15a00a67ca610b6c0806e2df2cbe7fe2a76a046a))


### Fixes

* **chat:** keep streaming timestamps out of line measurement ([2b6438c](https://github.com/markbang/cohub-mobile/commit/2b6438cc2e61ec16561a579830dbbf7c428bf4f6))
* **chat:** prevent Android text focus from jumping the timeline ([47d084d](https://github.com/markbang/cohub-mobile/commit/47d084d6d26a96cf84db1c2b392e7304289cdd71))
* **chat:** render nested markdown links and media previews ([1d0615c](https://github.com/markbang/cohub-mobile/commit/1d0615c369af19f313652d57f9c3a99ef1c846d5))
* **ui:** restore text filters and remove redundant status copy ([1daa6a9](https://github.com/markbang/cohub-mobile/commit/1daa6a940184baddc513c69b259b4eaa9d9ae396))


### Refactoring

* **activity:** remove recent works and generations sections ([ce28181](https://github.com/markbang/cohub-mobile/commit/ce28181730f08ea78bd49b0ede12b2b76d7cd73c))

## [2.2.0](https://github.com/markbang/cohub-mobile/compare/v2.1.0...v2.2.0) (2026-09-11)


### Features

* **chat:** add configurable recent filters and fix loading and bubble layout ([761fb2b](https://github.com/markbang/cohub-mobile/commit/761fb2b9467a1ebc1365b94519e87ce6286ff5d7))
* **debug:** add chat scroll diagnostics and turn tracing ([392a9ae](https://github.com/markbang/cohub-mobile/commit/392a9ae139c9662c55015141a67242e2f4d2d9a6))


### Fixes

* **chat:** preserve final reply ordering and reduce cache overhead ([c8b98b7](https://github.com/markbang/cohub-mobile/commit/c8b98b71a975bb17e4b0525655e98605b0435224))
* **deps:** align Expo SDK 57 patch versions ([09f10f7](https://github.com/markbang/cohub-mobile/commit/09f10f790124917db6b4dccffc84fe58960d3778))
* **deps:** consolidate stable SDK 57 updates for native release ([8b4763f](https://github.com/markbang/cohub-mobile/commit/8b4763ff6e7a4ec716208a8b4d243a2559794bec))
* **mobile:** align space filters and session lifecycle ([c724ed2](https://github.com/markbang/cohub-mobile/commit/c724ed2162b39bfeb64a2398ea32a33eb9e95e0c))

## [2.1.0](https://github.com/markbang/cohub-mobile/compare/v2.0.0...v2.1.0) (2026-09-10)


### Features

* **cache:** add a retention setting and narrow cache writes ([9e27d1e](https://github.com/markbang/cohub-mobile/commit/9e27d1e409961b60712e578e887b72aeb0a561c2))
* **chat:** drive the Chats/Files panels with a native push pager ([64f13db](https://github.com/markbang/cohub-mobile/commit/64f13dbb9f728047e2c76b9296b38d42a43ac6f2))
* **chat:** improve composer expansion and compact native menus ([55d7203](https://github.com/markbang/cohub-mobile/commit/55d720336663526f62293645bb197dc7c73abe36))
* **chat:** render compacted context turns ([9faf376](https://github.com/markbang/cohub-mobile/commit/9faf37634807efd1f029c76e3adbb3b21a29ba7f))
* **chat:** resolve Cohub mentions, files, and external links in messages ([6068fe7](https://github.com/markbang/cohub-mobile/commit/6068fe7fd59d9ba3cf81db91530f2de0ed4aef32))
* **debug:** add a synthetic usage control and mark bubble areas ([c54ba1c](https://github.com/markbang/cohub-mobile/commit/c54ba1c7881c2f62cc83f5a197a19527d84e2b54))
* **debug:** add bubble stress, OTA, cache, and composer inspectors ([7a9788d](https://github.com/markbang/cohub-mobile/commit/7a9788dd7c16f8a31041641335ae69fce6b49730))
* **debug:** inspect chat message usage and bubble footers ([f42dc80](https://github.com/markbang/cohub-mobile/commit/f42dc80cb3d917d79a77e92706125e67eb377b69))
* **debug:** show message shape and render guards in the usage inspector ([e6efd04](https://github.com/markbang/cohub-mobile/commit/e6efd04056db36caa2db9c2bb8d3fa0d5d4b8ed4))
* **debug:** turbo-charge streaming stress and add runtime inspectors ([661b4ca](https://github.com/markbang/cohub-mobile/commit/661b4ca8bc68ab94e887086cf7858ebd19733786))
* **i18n:** add Simplified Chinese support ([58b62f6](https://github.com/markbang/cohub-mobile/commit/58b62f63a1569fde5a1c827bab07aba53d4cce49))
* **mobile:** improve native navigation and composer ([e8c8ee4](https://github.com/markbang/cohub-mobile/commit/e8c8ee42ab5524a8b13190e6ac2e4a1c6436fbef))
* **space:** load Space Chats from the API and harden detail loading ([d6e85d2](https://github.com/markbang/cohub-mobile/commit/d6e85d2f4d06b24bb7d3c0b354b3c0cef87073cd))
* **ui:** add clock and archive icons ([b00de37](https://github.com/markbang/cohub-mobile/commit/b00de37e218421f985ecd4caba58d46758dd1390))
* **ui:** add expandable capsule search bar ([f1a46c7](https://github.com/markbang/cohub-mobile/commit/f1a46c777d1fcda12fe26fada0e3502a6bd7be19))
* **ui:** add toast system and migrate chat error notices ([f5ce40e](https://github.com/markbang/cohub-mobile/commit/f5ce40e0021f643e87bdcc7ebd44817cd1a3ce9d))
* **ui:** adopt platform-native motion and refine chat presentation ([241b2dd](https://github.com/markbang/cohub-mobile/commit/241b2ddfc8eccedb375fb6fbee9bec26644cab28))
* **ui:** polish chat bubbles, follow-up queue, and settings ([7b80f74](https://github.com/markbang/cohub-mobile/commit/7b80f7444a522014b2c367cd0ca009adcc349c4f))


### Fixes

* **android:** allow touch events through toolbar container ([d7c1866](https://github.com/markbang/cohub-mobile/commit/d7c186614d6a4da65a03de1a40d6de40be5db454))
* **android:** eliminate gap between composer and keyboard ([f85f341](https://github.com/markbang/cohub-mobile/commit/f85f3414f852bc19c58bb348debffbb6b0271ba4))
* **android:** use padding behavior with offset for keyboard avoidance ([a03d23e](https://github.com/markbang/cohub-mobile/commit/a03d23e15912dcfe421a4a9ec287827442ab4d6d))
* **cache:** persist realtime chat updates ([4427217](https://github.com/markbang/cohub-mobile/commit/44272178943fb56c33a83b952ebbc455ccbdfb62))
* **chat:** arbitrate panel swipe and text selection with the JS responder ([c8bc2a3](https://github.com/markbang/cohub-mobile/commit/c8bc2a35450026a9881205b48ad07f4e5931858a))
* **chat:** give the token footer a definite width and an explicit fallback ([134eedf](https://github.com/markbang/cohub-mobile/commit/134eedf7f3c51c543a555fc58d842cac00ac89c3))
* **chat:** keep token footer arrows out of i18n ([3bea673](https://github.com/markbang/cohub-mobile/commit/3bea673cc62b87c2f7cbcfad51f3657ed99eef22))
* **chat:** make text selection opt-in so the panel swipe keeps working ([8b6ba13](https://github.com/markbang/cohub-mobile/commit/8b6ba133629da44a66e4d3f405b4c77523bd5339))
* **chat:** polish composer and message interactions ([b38c27b](https://github.com/markbang/cohub-mobile/commit/b38c27bcd39dae4cd2b29420f9a88e51f9cbc661))
* **chat:** refine sharing and message presentation ([b9fec28](https://github.com/markbang/cohub-mobile/commit/b9fec2837ac318cd490f538182ebdb9bfdebbfd3))
* **chat:** render the token footer as one text run ([03fa230](https://github.com/markbang/cohub-mobile/commit/03fa2309025f82c6783d25bd50bac2363c78f121))
* **chat:** restore content-sized user message bubbles ([a76446b](https://github.com/markbang/cohub-mobile/commit/a76446b46640050509255dab19e2340b5d55041d))
* **chat:** restore fork actions for completed turns ([370413c](https://github.com/markbang/cohub-mobile/commit/370413cde899ca45d8877df6f3ebae5ba4f12a89))
* **mobile:** align attachment classification and model status feedback ([b9ccf0a](https://github.com/markbang/cohub-mobile/commit/b9ccf0ad587e305a54bc823dbad1a99335f11b95))
* **navigation:** restore Android back handling and add Profile back button ([463e7ca](https://github.com/markbang/cohub-mobile/commit/463e7ca39befefb6b63ab9367e41cacb12c4f917))
* **ota:** keep the runtime fingerprint stable for JS-only releases ([db7ee09](https://github.com/markbang/cohub-mobile/commit/db7ee0908e371f8df2765f525fc8bc0530f4b04a))
* **release:** locate nested Android APKs in the release artifact ([a0791b0](https://github.com/markbang/cohub-mobile/commit/a0791b059ffdf75d1136587336f2f5519498c228))
* **ui:** keep expanded search bar inside screen bounds ([95bb0d1](https://github.com/markbang/cohub-mobile/commit/95bb0d16e7fa49e71bbd82ce38153fccb36aefc1))
* **ui:** keep gallery thumbnails and avatars visible inside links ([a86715a](https://github.com/markbang/cohub-mobile/commit/a86715a30847efba86d1d6a985e571d122b57c4c))
* **ui:** keep short user bubble timestamps inline and fix Android keyboard inset ([08027ee](https://github.com/markbang/cohub-mobile/commit/08027eea9ef7cbea0d3a44161784df52f3f3479b))
* **ui:** use padding keyboard avoidance with an Android top offset ([f241821](https://github.com/markbang/cohub-mobile/commit/f241821cd40bbb4b18acdcea5e3799fbda2598b9))
* **uploads:** align signed content types with native file bodies ([19bebaa](https://github.com/markbang/cohub-mobile/commit/19bebaa4569d9f8a6ac4ec221a105cdd6b7e9450))


### Performance

* **ui:** optimize expandable search bar animations ([8230008](https://github.com/markbang/cohub-mobile/commit/82300083fa6b6c1d05b4e65fc30a8ab8627cf60a))

## [2.0.0](https://github.com/markbang/cohub-mobile/compare/v1.9.0...v2.0.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **ui:** Web platform removed. This app now targets iOS and Android only.

### Features

* **ui:** migrate to NativeTabs and remove web support ([f03a0dc](https://github.com/markbang/cohub-mobile/commit/f03a0dcaba3927262a31effa3320d094513c8540))


### Fixes

* **ota:** report fingerprint mismatch as an expected skip ([1dc4460](https://github.com/markbang/cohub-mobile/commit/1dc44607c1c98207c84b2faf21138156d90987bd))


### CI

* drop the removed web bundle job ([0342303](https://github.com/markbang/cohub-mobile/commit/03423035180b54e38c5526c1593e6cbc1552d46d))

## [1.9.0](https://github.com/markbang/cohub-mobile/compare/v1.8.2...v1.9.0) (2026-09-09)


### Features

* add swipeable message image gallery ([d47cbd4](https://github.com/markbang/cohub-mobile/commit/d47cbd4ffa56f2b4d20df0094f9cd8a957a474c7))
* **android:** prompt only when a new native build is available ([b23f3b0](https://github.com/markbang/cohub-mobile/commit/b23f3b03adb32f36cd5c4e10074f29e53e0ea6bb))
* **chat:** message actions, selectable text, image gallery, and streaming markdown ([0d17ce4](https://github.com/markbang/cohub-mobile/commit/0d17ce413a9e5c3524a92aa9d076065198fa7099))
* **chat:** pace streamed text by grapheme ([632c3a4](https://github.com/markbang/cohub-mobile/commit/632c3a4200eebe7d00cff2fc0986d11fe3aace39))


### Fixes

* constrain mobile message bubble layout ([c370624](https://github.com/markbang/cohub-mobile/commit/c37062498c42e455582acd0853694cf44d8e6e48))
* polish chat rendering and model search ([d3068e8](https://github.com/markbang/cohub-mobile/commit/d3068e8b2e0a77420864c9533575ec79d66487ac))
* stabilize assistant bubble width on mobile ([a17287c](https://github.com/markbang/cohub-mobile/commit/a17287ccf60cf64bb095062d5cfeaaaccf43096b))
* **ui:** use the generic mark for GPT-5.6 and newer ([d66fc1e](https://github.com/markbang/cohub-mobile/commit/d66fc1e65713981ce743e2d64fd31ff6b0fd4fb9))

## [1.8.2](https://github.com/markbang/cohub-mobile/compare/v1.8.1...v1.8.2) (2026-09-09)


### Fixes

* **ios:** declare export compliance in Info.plist ([a7f1f61](https://github.com/markbang/cohub-mobile/commit/a7f1f612a2e5135e2b713478aeb79bc1ec9c4f35))

## [1.8.1](https://github.com/markbang/cohub-mobile/compare/v1.8.0...v1.8.1) (2026-09-09)


### Fixes

* **ota:** keep the runtime stable across release version bumps ([9932eb5](https://github.com/markbang/cohub-mobile/commit/9932eb5f1d7032100324e256ec77980706b12b15))

## [1.8.0](https://github.com/markbang/cohub-mobile/compare/v1.7.0...v1.8.0) (2026-09-09)


### Features

* **app:** add a hidden Debug screen for render acceptance ([3d0b589](https://github.com/markbang/cohub-mobile/commit/3d0b589b0b02951b39d2d543cf3002752292cc40))
* **app:** add an app-wide text size setting ([2671949](https://github.com/markbang/cohub-mobile/commit/2671949d0027299ee59007fa8fd51e009a723e93))
* **app:** highlight code with shiki and edit workspace files ([bbce6de](https://github.com/markbang/cohub-mobile/commit/bbce6de36ded9ad1103ea3e99b7b850c5b46a2c3))
* **chat:** steer or cancel queued follow-ups ([8790104](https://github.com/markbang/cohub-mobile/commit/87901045b5b1fb7c6c1dddf8b8fe151e1c3f99f4))
* **ota:** publish production iOS updates on main pushes ([6780ade](https://github.com/markbang/cohub-mobile/commit/6780ade12891d88142a427dfc7cfb3cbb429ea1f))
* **ota:** publish production updates on main automatically ([#56](https://github.com/markbang/cohub-mobile/issues/56)) ([deb23cc](https://github.com/markbang/cohub-mobile/commit/deb23cce804d4bbd20a93e5ddd285b0c548922ae))
* **ui:** move profile out of tabs and add a floating tab bar ([fdc8633](https://github.com/markbang/cohub-mobile/commit/fdc8633c760eeb5d51273cf29c2d76746d3d413c))


### Fixes

* **app:** stop flagging recoverable realtime errors as outages ([2491151](https://github.com/markbang/cohub-mobile/commit/2491151a56dc2c44df113ee858ad825dd59b9f5f))
* **chat:** drop the blank gap under expanded tool bodies ([b90f1c8](https://github.com/markbang/cohub-mobile/commit/b90f1c82e2f416d53b9fb3f47a0f88f626071f7a))
* **chat:** keep new messages on screen and size bubbles correctly ([050aeca](https://github.com/markbang/cohub-mobile/commit/050aeca43dee2fa576fd20e6c91a7c95efd1d952))
* **chat:** keep panel swipe from selecting message text ([7cb2ffb](https://github.com/markbang/cohub-mobile/commit/7cb2ffb5e48a8a704cac16bf00600cabb41dc0b4))
* **chat:** keep send preview aligned with the final turn ([b51752b](https://github.com/markbang/cohub-mobile/commit/b51752b5c1d27faa52d5c82518c96109e056c3c4))
* **chat:** keep streaming bubbles from re-rendering and growing ([0b86b72](https://github.com/markbang/cohub-mobile/commit/0b86b72694072a1f9354f1c2892b21409cee6f59))
* **chat:** keep turn markers and working state after send ([53aa13c](https://github.com/markbang/cohub-mobile/commit/53aa13c4424aad1b973dfaecae115ea37d29f02f))
* **chat:** list existing labels so a session can be assigned ([7f3ca3b](https://github.com/markbang/cohub-mobile/commit/7f3ca3b09cbc8c0f4d26d03029f372e36e6f4efd))
* **chat:** open at the latest turn and hide update prompts ([a722a9e](https://github.com/markbang/cohub-mobile/commit/a722a9e24fceebec29674dccfbde72638343646b))
* **chat:** reconcile finished turns and use a context menu ([89193ca](https://github.com/markbang/cohub-mobile/commit/89193ca8a8ba13766459c3afd1114ad14fe9bed9))
* **chat:** recover live streams and turns after reconnect ([b076c70](https://github.com/markbang/cohub-mobile/commit/b076c7077a90aa5b5d64d470b343ac24e124bd18))
* **chat:** render from the latest turn and hide sync status ([bebaa35](https://github.com/markbang/cohub-mobile/commit/bebaa35d530cf5bc1ddce6d67a9a64b6393c3447))
* **chat:** render streamed markdown incrementally per block ([714c8e7](https://github.com/markbang/cohub-mobile/commit/714c8e7f12a772e27bd485d2d74fd7f67abac708))
* **chats:** classify mobile sessions as Web App ([75ed57f](https://github.com/markbang/cohub-mobile/commit/75ed57f34118bd2dd01e6de1b00dce8f3c40eee0))
* **chats:** derive running state from the latest turn ([567dd62](https://github.com/markbang/cohub-mobile/commit/567dd62092c0b76d186ad903529babbe9f9fb032))
* **chat:** separate source filters from labels ([e708cf3](https://github.com/markbang/cohub-mobile/commit/e708cf332e4affb586dbfa977b34b7c1c92bd13d))
* **chat:** show existing labels in the assignment sheet ([9391aca](https://github.com/markbang/cohub-mobile/commit/9391aca979b6b8e7528a6d628966611dcee06f41))
* **chats:** only poll turn status for recently updated sessions ([a5a692e](https://github.com/markbang/cohub-mobile/commit/a5a692ed26f02f696a57ab6a0d69d8ec2958c1e5))
* **chat:** use a compact message action sheet on long-press ([9a9d2c4](https://github.com/markbang/cohub-mobile/commit/9a9d2c430838665f062599acc6cf161d5725c859))
* **chat:** wrap code blocks instead of horizontal scrolling ([a01af9e](https://github.com/markbang/cohub-mobile/commit/a01af9e32f4be90dc906bec61c1d887534130b6b))
* enable iOS-only releases and complete TestFlight processing ([#51](https://github.com/markbang/cohub-mobile/issues/51)) ([0928fae](https://github.com/markbang/cohub-mobile/commit/0928faeea2ec26dae8a971abbd81a65dc0a28c7a))
* **ota:** index updates with the APK-embedded runtime ([#55](https://github.com/markbang/cohub-mobile/issues/55)) ([db422f0](https://github.com/markbang/cohub-mobile/commit/db422f0e55823c44033c0f1d9d1e244c8b7f8d8d))
* **ota:** publish updates under the installed APK fingerprint ([#54](https://github.com/markbang/cohub-mobile/issues/54)) ([8e1c8af](https://github.com/markbang/cohub-mobile/commit/8e1c8af1343755cb794413ba14a1cfa7155da5e5))
* **ui:** leave room for the footer when capping sheet bodies ([f1da355](https://github.com/markbang/cohub-mobile/commit/f1da3557120e100a9df0ec579a461e1ec7f3f5b4))
* **ui:** let the chat panel label row scroll horizontally ([140b748](https://github.com/markbang/cohub-mobile/commit/140b7482e21736e07d9e31199dbf32ab9812f067))
* **ui:** make the chat panel label row scroll reliably ([42790da](https://github.com/markbang/cohub-mobile/commit/42790da94e2305c1b0343ba2047f0b7c44cab0ee))
* **ui:** preserve PressableScale flex for pinned space rows ([#52](https://github.com/markbang/cohub-mobile/issues/52)) ([c4aa5d8](https://github.com/markbang/cohub-mobile/commit/c4aa5d8afdbcd0c81055386899a176c6fba00449))


### CI

* keep Expo 57.0.20 so production OTA matches the installed APK ([347f1db](https://github.com/markbang/cohub-mobile/commit/347f1db7ee8902f3d0e17ad2295ef13269537735))

## [1.7.0](https://github.com/markbang/cohub-mobile/compare/v1.6.0...v1.7.0) (2026-09-08)


### Features

* **android:** add in-app APK updates and signed OTA ([#50](https://github.com/markbang/cohub-mobile/issues/50)) ([3484e17](https://github.com/markbang/cohub-mobile/commit/3484e17d52d211c01e54001710f713d779898bfc))
* **chat:** use messenger-style bubbles for tools and replies ([#48](https://github.com/markbang/cohub-mobile/issues/48)) ([da2633f](https://github.com/markbang/cohub-mobile/commit/da2633f648036604f7d6eefc46d0cacf29c4a7d1))
* **mobile:** add native-feeling press feedback and motion tokens ([50f889e](https://github.com/markbang/cohub-mobile/commit/50f889e957c52ba838cc545dff98a2a0fdec6f87))
* **mobile:** adopt official logo and remove ripple feedback ([449d225](https://github.com/markbang/cohub-mobile/commit/449d225922a26a89940ef993e40d2618b5d061c8))
* **mobile:** organize chats by labels instead of pin ([5fa5437](https://github.com/markbang/cohub-mobile/commit/5fa5437d927e5940d8144ba68284de78c68c5617))
* **ui:** refine native-inspired chat surfaces ([cf765f3](https://github.com/markbang/cohub-mobile/commit/cf765f35e27543d5e55cc2ab4431792ef3e1763c))


### Fixes

* **chat:** satisfy check for turn details and workflow imports ([#49](https://github.com/markbang/cohub-mobile/issues/49)) ([f9f0c8a](https://github.com/markbang/cohub-mobile/commit/f9f0c8aea68760267817013c81439552b8489c82))

## [1.6.0](https://github.com/markbang/cohub-mobile/compare/v1.5.0...v1.6.0) (2026-09-07)


### Features

* **mobile:** add brand and file type icons ([f0a9c01](https://github.com/markbang/cohub-mobile/commit/f0a9c01d07e677475a44da3b9182ca6c0e17f312))
* **mobile:** align workspace UI with autonomous agent workflow ([f61712b](https://github.com/markbang/cohub-mobile/commit/f61712b89e2de9b51cda51444493e5c90e7add98))
* **mobile:** improve chat previews and markdown rendering ([4ce4d17](https://github.com/markbang/cohub-mobile/commit/4ce4d176d68218e579982b9293b47be921990cc8))


### Fixes

* **deps:** override decode-uri-component to patched 0.5.0 ([e972a46](https://github.com/markbang/cohub-mobile/commit/e972a469196299eaee50cc1603052a13e757fffe))
* **mobile:** close remaining review gaps ([c696c04](https://github.com/markbang/cohub-mobile/commit/c696c04185fc5afa5bd1b5d5123212f7aa530db4))
* **mobile:** guard preview route in production ([e9a2bac](https://github.com/markbang/cohub-mobile/commit/e9a2bacc33af90e07418d92a6715eaa11ba2c265))
* **mobile:** isolate preview route and list numbering ([105ede1](https://github.com/markbang/cohub-mobile/commit/105ede1a618f20e19b688cacd7ebee9b7ea477a7))
* **mobile:** keep scrollable sheets bounded ([61263c6](https://github.com/markbang/cohub-mobile/commit/61263c620f0e4a114181e87e620804e17dda5dc6))
* **mobile:** make press feedback feel native ([1a554d2](https://github.com/markbang/cohub-mobile/commit/1a554d2752948451ba579863a976e2b3b9bd5dbd))
* **mobile:** normalize markdown line endings ([d6dd567](https://github.com/markbang/cohub-mobile/commit/d6dd567113557ca7199d8fb3954851fc461dadf5))
* **mobile:** resolve review feedback ([bfd8f1a](https://github.com/markbang/cohub-mobile/commit/bfd8f1ab17196f7c0c648fab4e027b38dcf5935c))
* **mobile:** restore press feedback for active controls ([7677f0d](https://github.com/markbang/cohub-mobile/commit/7677f0dbed0cc28c42ce4949b210aa9abae80576))


### CI

* bump github/codeql-action from 3 to 4 ([#46](https://github.com/markbang/cohub-mobile/issues/46)) ([0951c99](https://github.com/markbang/cohub-mobile/commit/0951c99d411a7981f0fef62966dc59d27c40ca70))

## [1.5.0](https://github.com/markbang/cohub-mobile/compare/v1.4.1...v1.5.0) (2026-09-03)


### Features

* **mobile:** complete native settings, navigation, and updates ([#39](https://github.com/markbang/cohub-mobile/issues/39)) ([5e42f4d](https://github.com/markbang/cohub-mobile/commit/5e42f4daffdfbe6616a5d3fe144f861e561981c9))

## [1.4.1](https://github.com/markbang/cohub-mobile/compare/v1.4.0...v1.4.1) (2026-09-02)


### Fixes

* **mobile:** complete chat streaming and search parity ([#38](https://github.com/markbang/cohub-mobile/issues/38)) ([fb9d7df](https://github.com/markbang/cohub-mobile/commit/fb9d7df65467d9519239ef4733c2d4f288f46308))
* **mobile:** restore native panel swipe gestures ([#36](https://github.com/markbang/cohub-mobile/issues/36)) ([5dfd048](https://github.com/markbang/cohub-mobile/commit/5dfd048b18ba19cf5f6298d4febedaf59611092a))

## [1.4.0](https://github.com/markbang/cohub-mobile/compare/v1.3.1...v1.4.0) (2026-09-01)


### Features

* **mobile:** complete web parity workflow ([e3aae59](https://github.com/markbang/cohub-mobile/commit/e3aae590946daa092e1e072b18b65550726da263))

## [1.3.1](https://github.com/markbang/cohub-mobile/compare/v1.3.0...v1.3.1) (2026-08-31)


### Fixes

* **mobile:** avoid Expo Go notification crash ([#32](https://github.com/markbang/cohub-mobile/issues/32)) ([e064fe6](https://github.com/markbang/cohub-mobile/commit/e064fe6eb99b744b7998f6096fadb6e26aee3c26))

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
