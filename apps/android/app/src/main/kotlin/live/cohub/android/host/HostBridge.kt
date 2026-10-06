package live.cohub.android.host

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import live.cohub.android.auth.AuthSession
import live.cohub.android.runtime.DeviceRuntime
import live.cohub.android.runtime.FolderUnavailable
import live.cohub.android.runtime.toJson
import java.util.UUID

/**
 * Answers `cohub.host.v1` requests from the web surface.
 *
 * Uses `WebViewCompat.addWebMessageListener` rather than a `@JavascriptInterface`
 * object: it is confined to the Cohub origin, whereas a JavaScript interface is
 * reachable from any script the WebView ever loads.
 *
 * Lint's `RequiresFeature` check cannot follow the guard from [attach] into the
 * reply helpers, so it is suppressed at class level.
 */
@SuppressLint("RequiresFeature")
class HostBridge(
    private val scope: CoroutineScope,
    private val auth: AuthSession,
    private val actions: HostActions,
    private val runtime: DeviceRuntime? = null,
) {
    private val supportedMethods = if (runtime == null) BASE_METHODS else BASE_METHODS + RUNTIME_METHODS

    @Volatile
    private var replyProxy: JavaScriptReplyProxy? = null

    /** Returns false when this device's WebView cannot host a bridge. */
    fun attach(webView: WebView, allowedOrigin: Uri): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        attachListener(webView, allowedOrigin)
        return true
    }

    private fun attachListener(webView: WebView, allowedOrigin: Uri) {
        WebViewCompat.addWebMessageListener(
            webView,
            HostProtocol.GLOBAL,
            setOf(allowedOrigin.toString()),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    proxy: JavaScriptReplyProxy,
                ) {
                    // Only the top-level Cohub surface may drive native behaviour.
                    if (!isMainFrame) return
                    replyProxy = proxy
                    message.data?.let { handle(it, proxy) }
                }
            },
        )
    }

    private fun handle(data: String, proxy: JavaScriptReplyProxy) {
        val message = runCatching { Json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return
        if (message["type"]?.jsonPrimitive?.contentOrNull != "request") return
        val id = message["id"]?.jsonPrimitive?.contentOrNull ?: return
        val method = message["method"]?.jsonPrimitive?.contentOrNull ?: return
        val params = message["params"] as? JsonObject ?: JsonObject(emptyMap())

        // Unknown methods answer `unsupported` rather than staying silent, so the
        // web side falls back to its browser path instead of waiting.
        if (method !in supportedMethods) {
            replyError(proxy, id, HostProtocol.Errors.UNSUPPORTED, "Unsupported method: $method")
            return
        }

        scope.launch {
            runCatching { dispatch(method, id, params) }
                .onSuccess { result -> reply(proxy, id, result) }
                .onFailure { error ->
                    val code = if (error is CancellationSignal) {
                        HostProtocol.Errors.CANCELED
                    } else {
                        HostProtocol.Errors.FAILED
                    }
                    replyError(proxy, id, code, error.message ?: "Host call failed")
                }
        }
    }

    private suspend fun dispatch(method: String, id: String, params: JsonObject): JsonElement = when (method) {
        HostProtocol.Methods.HOST_DESCRIBE -> buildJsonObject {
            put("version", HostProtocol.VERSION)
            put("platform", HostProtocol.PLATFORM)
            put("hostId", actions.hostId())
            put(
                "capabilities",
                buildJsonArray { HostCapabilities.advertised(runtime != null).forEach { add(JsonPrimitive(it)) } },
            )
        }

        HostProtocol.Methods.AUTH_GET_ACCESS_TOKEN -> {
            // Booleans arrive typed, not stringified.
            val forceRefresh = params["forceRefresh"]?.jsonPrimitive?.booleanOrNull == true
            auth.accessToken(forceRefresh)?.let(::JsonPrimitive) ?: JsonPrimitive(null as String?)
        }

        HostProtocol.Methods.AUTH_GET_SESSION_VERSION -> JsonPrimitive(auth.sessionVersion())

        HostProtocol.Methods.AUTH_GET_SESSION -> {
            val identity = auth.status()
            buildJsonObject {
                put("authenticated", identity.authenticated)
                put("userUuid", identity.userUuid)
                put("subject", identity.subject)
                // ID token claims never cross the bridge; the web side uses /api/me.
                put("email", null as String?)
            }
        }

        HostProtocol.Methods.AUTH_SIGN_IN -> {
            actions.startSignIn(params["redirectPath"]?.jsonPrimitive?.contentOrNull)
            JsonPrimitive(true)
        }

        HostProtocol.Methods.AUTH_SIGN_OUT -> {
            actions.signOut()
            emit(HostProtocol.Events.AUTH_SIGNED_OUT)
            JsonPrimitive(true)
        }

        HostProtocol.Methods.SHARE_TEXT -> {
            val text = params["text"]?.jsonPrimitive?.contentOrNull
                ?: throw IllegalArgumentException("share.text requires text")
            actions.shareText(text, params["title"]?.jsonPrimitive?.contentOrNull)
            JsonPrimitive(true)
        }

        HostProtocol.Methods.NAVIGATION_OPEN_PATH -> {
            val path = params["path"]?.jsonPrimitive?.contentOrNull
                ?: throw IllegalArgumentException("navigation.openPath requires path")
            actions.openPath(path)
            JsonPrimitive(true)
        }

        HostProtocol.Methods.CACHE_CLEAR -> {
            actions.clearCache(params["scope"]?.jsonPrimitive?.contentOrNull ?: "all")
            JsonPrimitive(true)
        }

        HostProtocol.Methods.APPEARANCE_SET -> {
            val color = params["backgroundColor"]?.jsonPrimitive?.contentOrNull?.let(HostProtocol::parseColor)
                ?: throw IllegalArgumentException("appearance.set requires a #rrggbb backgroundColor")
            actions.setAppearance(color)
            JsonPrimitive(true)
        }

        HostProtocol.Methods.RUNTIME_LIST -> requireRuntime().instances.value.toJson()

        HostProtocol.Methods.RUNTIME_BROWSE -> {
            requireStorageAccess()
            try {
                requireRuntime().browse(params["path"]?.jsonPrimitive?.contentOrNull).toJson()
            } catch (error: FolderUnavailable) {
                throw IllegalArgumentException("Folder unavailable: ${error.message}")
            }
        }

        HostProtocol.Methods.RUNTIME_START -> {
            val spaceId = requireSpaceId(params)
            val root = params["root"]?.jsonPrimitive?.contentOrNull
                ?: throw IllegalArgumentException("runtime.start requires a folder")
            requireStorageAccess()
            val refused = requireRuntime().start(spaceId, root)
            JsonObject(requireRuntime().instances.value.toJson() + ("refused" to JsonPrimitive(refused)))
        }

        HostProtocol.Methods.RUNTIME_STOP -> {
            requireRuntime().stop(requireSpaceId(params))
            requireRuntime().instances.value.toJson()
        }

        else -> throw IllegalArgumentException("Unhandled method: $method")
    }

    private fun requireRuntime(): DeviceRuntime = runtime ?: throw IllegalStateException("This device cannot serve a Space")

    private suspend fun requireStorageAccess() {
        if (!actions.prepareRuntime()) throw CancellationSignal("All files access was not granted")
    }

    private fun requireSpaceId(params: JsonObject): String =
        params["spaceId"]?.jsonPrimitive?.contentOrNull?.takeIf { runCatching { UUID.fromString(it) }.isSuccess }
            ?: throw IllegalArgumentException("A Space id is required")

    /** Push a host event; dropped when no page is attached. */
    fun emit(name: String, payload: JsonElement? = null) {
        val proxy = replyProxy ?: return
        proxy.postMessage(
            buildJsonObject {
                put("type", "event")
                put("name", name)
                if (payload != null) put("payload", payload)
            }.toString(),
        )
    }

    private fun reply(proxy: JavaScriptReplyProxy, id: String, result: JsonElement) {
        proxy.postMessage(
            buildJsonObject {
                put("type", "response")
                put("id", id)
                put("result", result)
            }.toString(),
        )
    }

    private fun replyError(proxy: JavaScriptReplyProxy, id: String, code: String, message: String) {
        proxy.postMessage(
            buildJsonObject {
                put("type", "response")
                put("id", id)
                put(
                    "error",
                    buildJsonObject {
                        put("code", code)
                        put("message", message)
                    },
                )
            }.toString(),
        )
    }

    private companion object {
        val RUNTIME_METHODS = setOf(
            HostProtocol.Methods.RUNTIME_LIST,
            HostProtocol.Methods.RUNTIME_BROWSE,
            HostProtocol.Methods.RUNTIME_START,
            HostProtocol.Methods.RUNTIME_STOP,
        )
        val BASE_METHODS = setOf(
            HostProtocol.Methods.HOST_DESCRIBE,
            HostProtocol.Methods.AUTH_GET_ACCESS_TOKEN,
            HostProtocol.Methods.AUTH_GET_SESSION_VERSION,
            HostProtocol.Methods.AUTH_GET_SESSION,
            HostProtocol.Methods.AUTH_SIGN_IN,
            HostProtocol.Methods.AUTH_SIGN_OUT,
            HostProtocol.Methods.SHARE_TEXT,
            HostProtocol.Methods.NAVIGATION_OPEN_PATH,
            HostProtocol.Methods.CACHE_CLEAR,
            HostProtocol.Methods.APPEARANCE_SET,
        )
    }
}

/** Raised when the user or platform aborts a native surface; maps to `canceled`. */
class CancellationSignal(message: String) : Exception(message)

/** Native effects the bridge may request; an interface keeps it testable. */
interface HostActions {
    fun hostId(): String
    fun startSignIn(redirectPath: String?)
    suspend fun signOut()
    fun shareText(text: String, title: String?)
    fun openPath(path: String)
    fun clearCache(scope: String)
    fun setAppearance(backgroundColor: Int)

    suspend fun prepareRuntime(): Boolean
}
