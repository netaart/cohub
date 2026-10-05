package live.cohub.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import live.cohub.android.auth.AuthConfig
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.AuthorizationRequest
import live.cohub.android.auth.CredentialStore
import live.cohub.android.auth.Pkce
import live.cohub.android.host.CancellationSignal
import live.cohub.android.host.HostActions
import live.cohub.android.host.HostBridge
import live.cohub.android.host.WebSurface
import live.cohub.android.ui.WebSurfaceHost

/** The shell: one WebView for product UI, one bridge for native capability. */
class MainActivity : ComponentActivity(), HostActions {

    private lateinit var auth: AuthSession
    private lateinit var bridge: HostBridge
    private lateinit var surface: WebSurface
    private lateinit var customTabs: ActivityResultLauncher<Intent>

    /**
     * One immutable snapshot in a single volatile field, so the redirect handler
     * can never observe a half-updated sign-in request.
     */
    @Volatile
    private var pendingSignIn: PendingSignIn? = null

    private data class PendingSignIn(
        val challenge: Pkce.Challenge,
        val state: String,
        val redirectPath: String?,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        auth = AuthSession(
            store = CredentialStore(applicationContext),
            config = AuthConfig(
                endpoint = BuildConfig.LOGTO_ENDPOINT,
                appId = BuildConfig.LOGTO_APP_ID,
                redirectUri = BuildConfig.OAUTH_REDIRECT_URI,
                apiResource = BuildConfig.LOGTO_API_RESOURCE,
            ),
        )
        bridge = HostBridge(scope = lifecycleScope, auth = auth, actions = this)

        // The authorization result returns as a redirect intent, not an activity
        // result; this launcher only opens the browser.
        customTabs = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {}

        lifecycleScope.launch {
            auth.restore()
            intent?.data?.takeIf(::isSignInRedirect)?.let(::handleSignInRedirect)
        }

        setContent {
            MaterialTheme {
                Surface {
                    WebSurfaceHost(
                        onCreate = { webView, recreate ->
                            surface = WebSurface(
                                webView = webView,
                                onExternalLink = ::openExternally,
                                onRenderProcessGone = recreate,
                            )
                            // Without the bridge the surface still runs on its
                            // browser path; this only explains missing features.
                            if (!bridge.attach(webView, BuildConfig.WEB_ORIGIN.toUri())) {
                                Toast.makeText(this@MainActivity, R.string.bridge_unavailable, Toast.LENGTH_LONG).show()
                            }
                            surface.load()
                            surface
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.takeIf(::isSignInRedirect)?.let(::handleSignInRedirect)
    }

    override fun hostId(): String = installId()

    override fun startSignIn(redirectPath: String?) {
        val challenge = Pkce.create()
        val state = Pkce.createState()
        pendingSignIn = PendingSignIn(challenge, state, redirectPath)

        val url = AuthorizationRequest.build(
            endpoint = BuildConfig.LOGTO_ENDPOINT,
            appId = BuildConfig.LOGTO_APP_ID,
            redirectUri = BuildConfig.OAUTH_REDIRECT_URI,
            resource = BuildConfig.LOGTO_API_RESOURCE,
            challenge = challenge,
            state = state,
        )
        try {
            customTabs.launch(CustomTabsIntent.Builder().build().intent.apply { data = url })
        } catch (_: ActivityNotFoundException) {
            // Falling back to a WebView sign-in would create a session no other
            // surface can share, so failing loudly is the safer behaviour.
            throw CancellationSignal("No browser available to complete sign-in")
        }
    }

    override fun shareText(text: String, title: String?) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            if (title != null) putExtra(Intent.EXTRA_SUBJECT, title)
        }
        startActivity(Intent.createChooser(send, title))
    }

    override fun openPath(path: String) {
        if (path.startsWith("/")) {
            surface.load(path)
            return
        }
        openExternally(path.toUri())
    }

    override fun clearCache(scope: String) {
        // IndexedDB belongs to the web app; the host clears only what it owns.
        if (scope == "user" || scope == "all") auth.clear()
    }

    private fun isSignInRedirect(data: Uri): Boolean =
        data.toString().startsWith(BuildConfig.OAUTH_REDIRECT_URI)

    private fun handleSignInRedirect(data: Uri) {
        // Claim the pending request first so a second redirect cannot reuse it.
        val pending = pendingSignIn
        pendingSignIn = null

        // A mismatched state is not the response to our request; refusing it
        // prevents a code-injection attempt.
        if (pending == null || data.getQueryParameter("state") != pending.state) {
            toast(R.string.sign_in_failed)
            return
        }
        val code = data.getQueryParameter("code") ?: run {
            toast(R.string.sign_in_failed)
            return
        }

        lifecycleScope.launch {
            runCatching { auth.completeSignIn(code, pending.challenge.verifier) }
                .onFailure {
                    Log.w(TAG, "Sign-in failed", it)
                    toast(R.string.sign_in_failed)
                }
            surface.load(pending.redirectPath ?: "/")
        }
    }

    private fun toast(messageRes: Int) {
        Toast.makeText(this, messageRes, Toast.LENGTH_SHORT).show()
    }

    private fun openExternally(uri: Uri) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            .onFailure { toast(R.string.no_app_for_link) }
    }

    /** Stable per-install id for routing hints; never an authorization input. */
    private fun installId(): String {
        val prefs = getSharedPreferences("cohub-host", MODE_PRIVATE)
        return prefs.getString(KEY_INSTALL_ID, null) ?: java.util.UUID.randomUUID().toString().also {
            prefs.edit { putString(KEY_INSTALL_ID, it) }
        }
    }

    private companion object {
        const val TAG = "CohubShell"
        const val KEY_INSTALL_ID = "install_id"
    }
}
