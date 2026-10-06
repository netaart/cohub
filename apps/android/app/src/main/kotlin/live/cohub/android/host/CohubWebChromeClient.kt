package live.cohub.android.host

import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
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
