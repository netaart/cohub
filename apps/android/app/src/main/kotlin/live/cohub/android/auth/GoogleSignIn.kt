package live.cohub.android.auth

import android.annotation.SuppressLint
import android.net.Uri
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.net.toUri
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import live.cohub.android.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

class GoogleSignIn(private val activity: ComponentActivity, private val http: OkHttpClient) {

    sealed interface Result {
        class Redirected(val uri: Uri) : Result

        data object Canceled : Result

        data object Unavailable : Result

        data object Failed : Result
    }

    suspend fun signIn(state: String, redirectUri: String, authorize: (credential: String) -> Uri): Result {
        val clientId = clientId() ?: return Result.Unavailable
        val handoff = Handoff(redirectUri.toUri(), state)
        try {
            val option = GetSignInWithGoogleOption.Builder(clientId).setNonce(nonce(state)).build()
            val credential = try {
                val response = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest(listOf(option)))
                val custom = response.credential as? CustomCredential
                if (custom?.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) return Result.Unavailable
                GoogleIdTokenCredential.createFrom(custom.data).idToken
            } catch (_: GetCredentialCancellationException) {
                return Result.Canceled
            } catch (_: NoCredentialException) {
                return Result.Unavailable
            } catch (error: GetCredentialException) {
                Log.i(TAG, "Google sign-in is unavailable: ${error.type}")
                return Result.Unavailable
            } catch (_: GoogleIdTokenParsingException) {
                return Result.Unavailable
            }
            return withTimeoutOrNull(HANDOFF_TIMEOUT_MS) { handoff.run(authorize(credential)) } ?: Result.Unavailable
        } finally {
            handoff.close()
        }
    }

    suspend fun forget() {
        try {
            CredentialManager.create(activity).clearCredentialState(ClearCredentialStateRequest())
        } catch (error: ClearCredentialException) {
            Log.i(TAG, "Could not clear the Google credential state: ${error.type}")
        }
    }

    private suspend fun clientId(): String? = cachedClientId ?: withContext(Dispatchers.IO) {
        val request = Request.Builder().url(BuildConfig.LOGTO_ENDPOINT.trimEnd('/') + SIGN_IN_EXPERIENCE).build()
        runCatching {
            http.newCall(request).apply { timeout().timeout(CONFIG_TIMEOUT_S, TimeUnit.SECONDS) }.execute().use { response ->
                if (!response.isSuccessful) return@use null
                val oneTap = (Json.parseToJsonElement(response.body.string()) as? JsonObject)?.get("googleOneTap") as? JsonObject
                oneTap?.takeIf { it["isEnabled"]?.jsonPrimitive?.booleanOrNull == true }
                    ?.get("clientId")?.jsonPrimitive?.contentOrNull?.takeIf(CLIENT_ID::matches)
            }
        }.onFailure { Log.w(TAG, "Could not read Logto's Google client", it) }.getOrNull()
    }?.also { cachedClientId = it }

    @SuppressLint("SetJavaScriptEnabled", "MissingOnRenderProcessGone")
    private inner class Handoff(private val redirect: Uri, private val state: String) {
        private val logto = BuildConfig.LOGTO_ENDPOINT.toUri()
        private var pending: CancellableContinuation<Result>? = null
        private var started = false

        private val view = WebView(activity).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            isFocusable = false
            isFocusableInTouchMode = false
            descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage) = true
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (sameEndpoint(url, redirect) && url.path == redirect.path) {
                        if (request.isForMainFrame) finish(if (url.getQueryParameter("state") == state) Result.Redirected(url) else Result.Failed)
                        return true
                    }
                    val allowed = isLogto(url)
                    if (!allowed && request.isForMainFrame) finish(Result.Unavailable)
                    return !allowed
                }

                override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                    val page = url.toUri()
                    if (isLogto(page) && needsPerson(page.path)) finish(Result.Unavailable)
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (isHandoffPage(request)) finish(Result.Unavailable)
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    if (isHandoffPage(request)) finish(Result.Unavailable)
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    finish(Result.Unavailable)
                    return true
                }
            }
        }

        init {
            activity.findViewById<ViewGroup>(android.R.id.content).addView(view, 0, ViewGroup.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            view.loadUrl(BuildConfig.LOGTO_ENDPOINT.trimEnd('/') + WARM_UP)
        }

        suspend fun run(authorization: Uri): Result = suspendCancellableCoroutine { continuation ->
            pending = continuation
            started = true
            view.loadUrl(authorization.toString())
        }

        private fun finish(result: Result) {
            if (!started) return
            val continuation = pending ?: return
            pending = null
            if (continuation.isActive) continuation.resume(result)
        }

        fun close() {
            pending = null
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
        }

        private fun isHandoffPage(request: WebResourceRequest) = request.isForMainFrame && request.url.path != WARM_UP

        private fun isLogto(url: Uri) = url.scheme == "https" && url.userInfo == null && sameEndpoint(url, logto)

        private fun sameEndpoint(a: Uri, b: Uri) = a.scheme == b.scheme && a.host == b.host && a.port == b.port
    }

    companion object {
        private const val TAG = "CohubAuth"
        private const val SIGN_IN_EXPERIENCE = "/api/.well-known/sign-in-exp"
        private const val WARM_UP = "/oidc/.well-known/openid-configuration"
        private const val CONFIG_TIMEOUT_S = 5L
        private const val HANDOFF_TIMEOUT_MS = 60_000L
        private val CLIENT_ID = Regex("^[A-Za-z0-9-]+\\.apps\\.googleusercontent\\.com$")

        @Volatile
        private var cachedClientId: String? = null

        fun nonce(state: String): String = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest("cohub.google:$state".toByteArray(Charsets.UTF_8)))

        fun needsPerson(path: String?): Boolean {
            val route = path.orEmpty()
            return AUTOMATIC.none { route == it || route.startsWith("$it/") }
        }

        private val AUTOMATIC = listOf("/oidc", "/direct/social", "/callback")
    }
}
