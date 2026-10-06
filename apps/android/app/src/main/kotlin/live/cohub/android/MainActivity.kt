package live.cohub.android

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.edit
import androidx.core.graphics.drawable.toDrawable
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.AuthorizationRequest
import live.cohub.android.auth.Pkce
import live.cohub.android.host.CancellationSignal
import live.cohub.android.host.HostActions
import live.cohub.android.host.HostBridge
import live.cohub.android.host.HostProtocol
import live.cohub.android.host.LastPage
import live.cohub.android.host.WebOrigin
import live.cohub.android.host.WebSurface
import live.cohub.android.runtime.DeviceRuntime
import live.cohub.android.runtime.toJson
import live.cohub.android.ui.ShellAppearance
import live.cohub.android.ui.SurfaceContainer

/** The shell: one WebView for product UI, one bridge for native capability. */
class MainActivity : ComponentActivity(), HostActions {

    private lateinit var auth: AuthSession
    private lateinit var runtime: DeviceRuntime
    private lateinit var bridge: HostBridge
    private lateinit var lastPage: LastPage
    private lateinit var container: SurfaceContainer
    private lateinit var surface: WebSurface
    private lateinit var appearance: ShellAppearance
    private lateinit var customTabs: ActivityResultLauncher<Intent>
    private lateinit var allFilesAccess: ActivityResultLauncher<Intent>
    private lateinit var notificationPermission: ActivityResultLauncher<String>
    private val hostPrefs by lazy { getSharedPreferences("cohub-host", MODE_PRIVATE) }
    private var pendingResult: CompletableDeferred<Unit>? = null
    private val preparing = Mutex()

    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = surface.goBack()
    }

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
        appearance = ShellAppearance(this)
        applyAppearance()

        val app = application as CohubApplication
        auth = app.auth
        runtime = app.runtime
        lastPage = app.lastPage
        bridge = HostBridge(
            scope = lifecycleScope,
            auth = auth,
            actions = this,
            runtime = runtime.takeIf { it.available },
        )

        // The authorization result returns as a redirect intent, not an activity
        // result; this launcher only opens the browser.
        customTabs = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {}
        allFilesAccess = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            pendingResult?.complete(Unit)
        }
        notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            pendingResult?.complete(Unit)
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                runtime.instances.collect { bridge.emit(HostProtocol.Events.RUNTIME_CHANGED, it.toJson()) }
            }
        }

        onBackPressedDispatcher.addCallback(this, back)
        container = SurfaceContainer(this)
        setContentView(container)
        // Recents replays the launching intent after a process death.
        val link = intent?.data?.takeIf {
            savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
        }
        mountSurface(link?.takeUnless(::isSignInRedirect)?.let(WebOrigin::pathOf) ?: lastPage.read() ?: "/")
        link?.takeIf(::isSignInRedirect)?.let(::handleSignInRedirect)
    }

    override fun onDestroy() {
        container.removeAllViews()
        surface.destroy()
        super.onDestroy()
    }

    private fun mountSurface(path: String) {
        surface = WebSurface(
            context = this,
            onExternalLink = ::openExternally,
            onNavigated = ::onNavigated,
            onRenderProcessGone = ::remountSurface,
        )
        surface.setBackgroundColor(appearance.backgroundColor)
        // Without the bridge the surface still runs on its browser path; this
        // only explains missing features.
        if (!bridge.attach(surface.view, WebOrigin.uri)) {
            Toast.makeText(this, R.string.bridge_unavailable, Toast.LENGTH_LONG).show()
        }
        container.show(surface.view)
        surface.load(path)
    }

    private fun remountSurface() {
        val dead = surface
        container.removeView(dead.view)
        dead.destroy()
        back.isEnabled = false
        mountSurface(lastPage.read() ?: "/")
    }

    private fun onNavigated(url: String) {
        back.isEnabled = surface.canGoBack()
        lastPage.remember(url)
    }

    override fun onStart() {
        super.onStart()
        runtime.resume()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val data = intent.data ?: return
        if (isSignInRedirect(data)) handleSignInRedirect(data) else WebOrigin.pathOf(data)?.let(surface::load)
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
            forceLogin = hostPrefs.getBoolean(KEY_FORCE_LOGIN, false),
        )
        try {
            customTabs.launch(CustomTabsIntent.Builder().build().intent.apply { data = url })
        } catch (_: ActivityNotFoundException) {
            // Falling back to a WebView sign-in would create a session no other
            // surface can share, so failing loudly is the safer behaviour.
            throw CancellationSignal("No browser available to complete sign-in")
        }
    }

    override suspend fun signOut() {
        hostPrefs.edit { putBoolean(KEY_FORCE_LOGIN, true) }
        auth.signOut()
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

    override fun setAppearance(backgroundColor: Int) {
        if (!appearance.update(backgroundColor)) return
        applyAppearance()
        surface.setBackgroundColor(backgroundColor)
    }

    private fun applyAppearance() {
        val style = if (appearance.isDark) {
            SystemBarStyle.dark(Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        }
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        window.setBackgroundDrawable(appearance.backgroundColor.toDrawable())
    }

    override suspend fun prepareRuntime(): Boolean = preparing.withLock {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            awaitResult(notificationPermission, Manifest.permission.POST_NOTIFICATIONS)
        }
        if (runtime.hasStorageAccess()) return@withLock true
        try {
            awaitResult(
                allFilesAccess,
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, "package:$packageName".toUri()),
            )
        } catch (_: ActivityNotFoundException) {
            awaitResult(allFilesAccess, Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
        runtime.hasStorageAccess()
    }

    private suspend fun <I> awaitResult(launcher: ActivityResultLauncher<I>, input: I) {
        val result = CompletableDeferred<Unit>()
        pendingResult = result
        launcher.launch(input)
        result.await()
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
                .onSuccess { hostPrefs.edit { remove(KEY_FORCE_LOGIN) } }
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
    private fun installId(): String =
        hostPrefs.getString(KEY_INSTALL_ID, null) ?: java.util.UUID.randomUUID().toString().also {
            hostPrefs.edit { putString(KEY_INSTALL_ID, it) }
        }

    private companion object {
        const val TAG = "CohubShell"
        const val KEY_INSTALL_ID = "install_id"
        const val KEY_FORCE_LOGIN = "force_login"
    }
}
