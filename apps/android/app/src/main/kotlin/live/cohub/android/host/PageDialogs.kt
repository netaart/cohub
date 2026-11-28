package live.cohub.android.host

import java.net.URI

class PageDialog(
    val kind: Kind,
    val message: String,
    val title: String?,
    val defaultText: String? = null,
    private val answer: (confirmed: Boolean, text: String?) -> Unit,
) {
    enum class Kind { ALERT, CONFIRM, PROMPT, BEFORE_UNLOAD }

    var settled = false
        private set

    fun settle(confirmed: Boolean, text: String? = null) {
        if (settled) return
        settled = true
        answer(confirmed, text.takeIf { confirmed })
    }

    companion object {
        fun titleFor(frameUrl: String, origin: String): String? {
            val frame = runCatching { URI(frameUrl) }.getOrNull()
            val own = URI(origin)
            val sameOrigin = frame != null &&
                frame.scheme.equals(own.scheme, ignoreCase = true) &&
                frame.host.equals(own.host, ignoreCase = true) &&
                port(frame) == port(own)
            return if (sameOrigin) null else frame?.host ?: frame?.scheme ?: frameUrl
        }

        private fun port(uri: URI): Int = when {
            uri.port != -1 -> uri.port
            uri.scheme.equals("https", ignoreCase = true) -> 443
            uri.scheme.equals("http", ignoreCase = true) -> 80
            else -> -1
        }
    }
}

class PageDialogs(private val show: (PageDialog) -> () -> Unit) {
    private var open: PageDialog? = null
    private var close: (() -> Unit)? = null

    fun request(dialog: PageDialog) {
        if (open?.settled == false) return dialog.settle(false)
        open = dialog
        close = show(dialog)
    }

    fun dismiss() {
        val dialog = open ?: return
        val closing = close
        open = null
        close = null
        dialog.settle(false)
        closing?.invoke()
    }
}
