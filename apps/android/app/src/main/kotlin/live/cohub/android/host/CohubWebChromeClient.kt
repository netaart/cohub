package live.cohub.android.host

import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import live.cohub.android.BuildConfig

/** Mirrors page console output to logcat in debug builds. */
class CohubWebChromeClient : WebChromeClient() {

    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        if (!BuildConfig.DEBUG) return false
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
