package live.cohub.android.host

import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import live.cohub.android.BuildConfig

class CohubWebChromeClient(private val listener: SurfaceListener) : WebChromeClient() {

    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean = listener.onShowFileChooser(filePathCallback, fileChooserParams)

    override fun onPermissionRequest(request: PermissionRequest) = listener.onPermissionRequest(request)

    override fun onPermissionRequestCanceled(request: PermissionRequest) = listener.onPermissionRequestCanceled(request)

    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
        listener.onGeolocationPrompt(origin, callback)

    override fun onGeolocationPermissionsHidePrompt() = listener.onGeolocationPromptHidden()

    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
        ask(PageDialog.Kind.ALERT, url, message, result)

    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
        ask(PageDialog.Kind.CONFIRM, url, message, result)

    override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean =
        ask(PageDialog.Kind.BEFORE_UNLOAD, url, message, result)

    override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean {
        listener.onPageDialog(
            PageDialog(PageDialog.Kind.PROMPT, message, title(url), defaultValue) { confirmed, text ->
                if (confirmed) result.confirm(text.orEmpty()) else result.cancel()
            },
        )
        return true
    }

    private fun ask(kind: PageDialog.Kind, url: String, message: String, result: JsResult): Boolean {
        listener.onPageDialog(PageDialog(kind, message, title(url)) { confirmed, _ -> if (confirmed) result.confirm() else result.cancel() })
        return true
    }

    private fun title(url: String) = PageDialog.titleFor(url, BuildConfig.WEB_ORIGIN)

    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        if (!BuildConfig.WEB_DEBUGGING) return false
        val line = "${message.message()} (${message.sourceId()}:${message.lineNumber()})"
        when (message.messageLevel()) {
            ConsoleMessage.MessageLevel.ERROR -> Log.e(TAG, line)
            ConsoleMessage.MessageLevel.WARNING -> Log.w(TAG, line)
            ConsoleMessage.MessageLevel.DEBUG -> Log.d(TAG, line)
            else -> Log.i(TAG, line)
        }
        return true
    }

    private companion object {
        const val TAG = "CohubWeb"
    }
}
