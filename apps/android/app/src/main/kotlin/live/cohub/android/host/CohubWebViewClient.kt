package live.cohub.android.host

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.util.Log
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import live.cohub.android.runtime.LocalWorkspaces

/**
 * Only the Cohub origin loads as the top document; a link elsewhere opens
 * outside when its scheme may, so the bridge injection surface never sees
 * third-party pages. Frames (Apps) navigate where they like, never outside.
 *
 * Lint only recognises the `onRenderProcessGone` override on anonymous
 * `WebViewClient` objects, hence the suppression.
 */
@SuppressLint("MissingOnRenderProcessGone")
class CohubWebViewClient(
    private val listener: SurfaceListener,
    private val workspaces: LocalWorkspaces?,
) : WebViewClient() {

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (!WebOrigin.contains(url)) return null
        val path = url.path ?: return null
        return when {
            path.startsWith(HostProtocol.SHARE_PATH) -> listener.onSharedFileRequest(request)
            workspaces != null && path.startsWith(LocalWorkspaces.PATH_PREFIX) -> workspaces.intercept(request)
            else -> null
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (WebOrigin.contains(url) || !request.isForMainFrame) return false
        if (url.scheme?.lowercase() in HostProtocol.EXTERNAL_SCHEMES) listener.onExternalLink(url)
        return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        listener.onPageStarted()
    }

    override fun onPageCommitVisible(view: WebView, url: String) {
        listener.onPageCommitted()
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame) return
        LaunchFailure.of(error.errorCode)?.let { listener.onLoadFailed(it, request.url) }
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        listener.onNavigated(url)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail?): Boolean {
        val crashed = detail?.didCrash() ?: true
        Log.w(TAG, "Renderer gone (crashed=$crashed, priority=${detail?.rendererPriorityAtExit()})")
        listener.onRenderProcessGone(crashed)
        return true
    }

    private companion object {
        const val TAG = "CohubShell"
    }
}

enum class LaunchFailure {
    OFFLINE,
    BROKEN,
    ;

    companion object {
        fun of(code: Int): LaunchFailure? = when (code) {
            WebViewClient.ERROR_HOST_LOOKUP,
            WebViewClient.ERROR_CONNECT,
            WebViewClient.ERROR_TIMEOUT,
            WebViewClient.ERROR_IO,
            -> OFFLINE
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> BROKEN
            else -> null
        }
    }
}
