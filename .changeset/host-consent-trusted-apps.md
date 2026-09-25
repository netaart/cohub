---
"@neta-art/cohub": minor
---

Apps the Shell Space published or installed are now authorized without a dialog, including on a first visit and for `file.edit`. The Shell sends Host consent (`consent: "host"`), so the API can create the grant instead of only renewing one, while a grant the viewer revoked still asks again. Other Apps keep the renew-only path, so opening an unknown App never hands it the Space. Hosts report installation through the new `isInstalledIn` option of `createAppBridgeCore`. The API caps Host consent at the read-only Shell scopes plus `file.edit`.

当前 Space 发布或安装的 App 现在可以免弹窗授权，首次访问和 `file.edit` 也不例外。Shell 以 Host 同意（`consent: "host"`）发起请求，API 可以新建授权而不只是续期；访客撤销过的授权仍会重新询问。其他 App 仍然只能续期已有授权，打开一个陌生 App 不会让它拿到这个 Space。Host 通过 `createAppBridgeCore` 新增的 `isInstalledIn` 选项告知安装状态。API 将 Host 同意的范围限定为只读 Shell 权限加 `file.edit`。
