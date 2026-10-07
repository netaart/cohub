package live.cohub.android

import android.Manifest
import android.app.AppOpsManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.HapticFeedbackConstants
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
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
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.withStarted
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.AuthorizationRequest
import live.cohub.android.auth.Pkce
import live.cohub.android.files.FileChooser
import live.cohub.android.host.CancellationSignal
import live.cohub.android.host.HostActions
import live.cohub.android.host.HostBridge
import live.cohub.android.host.HostProtocol
import live.cohub.android.host.LastPage
import live.cohub.android.host.LauncherShortcuts
import live.cohub.android.host.ScreenCaptureGrant
import live.cohub.android.host.SurfaceListener
import live.cohub.android.host.WebOrigin
import live.cohub.android.host.WebSurface
import live.cohub.android.host.WebWarmup
import live.cohub.android.runtime.DeviceRuntime
import live.cohub.android.runtime.RuntimeService
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
    private lateinit var appearance: ShellAppearance
    private lateinit var fileChooser: FileChooser
    private lateinit var customTabs: ActivityResultLauncher<Intent>
    private lateinit var allFilesAccess: ActivityResultLauncher<Intent>
    private lateinit var notificationPermission: ActivityResultLauncher<String>
    private lateinit var screenCapture: ActivityResultLauncher<Intent>
    private var pendingCapture: CompletableDeferred<ScreenCaptureGrant?>? = null
    private val app get() = application as CohubApplication
    private val hostPrefs by lazy { getSharedPreferences("cohub-host", MODE_PRIVATE) }
    private var pendingResult: CompletableDeferred<Unit>? = null
    private val preparing = Mutex()

    private var surface: WebSurface? = null
    private var startPath = "/"

    private var launched = false
    private var reportedDrawn = false

    private val historyBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            surface?.goBack()
        }
    }

    private val layerBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = bridge.emit(HostProtocol.Events.NAVIGATION_BACK)
    }

    private val surfaceListener = object : SurfaceListener {
        override fun onExternalLink(url: Uri) = openExternally(url)

        override fun onPageStarted() {
            layerBack.isEnabled = false
        }

        override fun onNavigated(url: String) {
            historyBack.isEnabled = surface?.canGoBack() == true
            lastPage.remember(url)
        }

        override fun onRenderProcessGone() = remountSurface()

        override fun onShowFileChooser(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
            fileChooser.show(callback, params)

        override fun onDownload(url: String, contentDisposition: String?, mimeType: String?) =
            download(url, contentDisposition, mimeType)
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
        installSplashScreen().apply {
            setKeepOnScreenCondition { !launched }
            setOnExitAnimationListener { splash ->
                splash.view.animate().alpha(0f).setDuration(SPLASH_FADE_MS).withEndAction(splash::remove).start()
            }
        }
        super.onCreate(savedInstanceState)
        appearance = ShellAppearance(this)
        applyAppearance()

        auth = app.auth
        runtime = app.runtime
        lastPage = app.lastPage
        bridge = HostBridge(
            scope = lifecycleScope,
            auth = auth,
            actions = this,
            runtime = runtime.takeIf { it.available },
            files = app.files,
            display = app.display,
        )
        fileChooser = FileChooser(this)

        // The authorization result returns as a redirect intent, not an activity
        // result; this launcher only opens the browser.
        customTabs = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {}
        allFilesAccess = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            pendingResult?.complete(Unit)
        }
        notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            pendingResult?.complete(Unit)
        }
        screenCapture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            pendingCapture?.complete(if (result.resultCode == RESULT_OK && data != null) ScreenCaptureGrant(result.resultCode, data) else null)
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                runtime.instances.collect { bridge.emit(HostProtocol.Events.RUNTIME_CHANGED, it.toJson()) }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.display.status.collect { bridge.emit(HostProtocol.Events.DISPLAY_CHANGED, it.toJson()) }
            }
        }

        onBackPressedDispatcher.addCallback(this, historyBack)
        onBackPressedDispatcher.addCallback(this, layerBack)
        container = SurfaceContainer(this)
        setContentView(container)
        container.postDelayed(::lift, LAUNCH_TIMEOUT_MS)
        // Recents replays the launching intent after a process death.
        val link = intent?.data?.takeIf {
            savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
        }
        startPath = link?.takeUnless(::isSignInRedirect)?.let(WebOrigin::pathOf) ?: lastPage.read() ?: "/"
        WebSurface.startUp(this) { if (!isDestroyed) mountSurface(startPath) }
        link?.takeIf(::isSignInRedirect)?.let(::handleSignInRedirect)
    }

    override fun onDestroy() {
        container.removeAllViews()
        surface?.destroy()
        super.onDestroy()
    }

    private fun mountSurface(path: String) {
        WebWarmup.prefetch(path)
        val next = WebSurface(this, surfaceListener)
        next.setBackgroundColor(appearance.backgroundColor)
        // Without the bridge the surface still runs on its browser path; this
        // only explains missing features.
        if (!bridge.attach(next.view, WebOrigin.uri)) {
            Toast.makeText(this, R.string.bridge_unavailable, Toast.LENGTH_LONG).show()
        }
        container.show(next.view)
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) next.pause()
        surface = next
        next.load(path)
    }

    private fun remountSurface() {
        val dead = surface ?: return
        surface = null
        container.removeView(dead.view)
        dead.destroy()
        historyBack.isEnabled = false
        layerBack.isEnabled = false
        mountSurface(lastPage.read() ?: "/")
    }

    private fun navigate(path: String) {
        surface?.load(path) ?: run { startPath = path }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch {
            auth.load()
            withStarted { runtime.resume() }
        }
        surface?.resume()
        bridge.emit(HostProtocol.Events.APP_FOREGROUND)
    }

    override fun onStop() {
        surface?.pause()
        bridge.emit(HostProtocol.Events.APP_BACKGROUND)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val data = intent.data ?: return
        if (isSignInRedirect(data)) handleSignInRedirect(data) else WebOrigin.pathOf(data)?.let(::navigate)
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
            navigate(path)
            return
        }
        openExternally(path.toUri())
    }

    override suspend fun clearCache(scope: String) {
        // IndexedDB belongs to the web app; the host clears only what it owns.
        if (scope == "user" || scope == "all") auth.clear()
    }

    override fun setAppearance(backgroundColor: Int) {
        if (!appearance.update(backgroundColor)) return
        applyAppearance()
        surface?.setBackgroundColor(backgroundColor)
    }

    override fun appReady() {
        lift()
        if (reportedDrawn) return
        reportedDrawn = true
        reportFullyDrawn()
    }

    private fun lift() {
        launched = true
    }

    override fun performHaptic(kind: HostProtocol.Haptic): Boolean {
        val view = surface?.view ?: return false
        val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val feedback = when (kind) {
            HostProtocol.Haptic.TICK -> HapticFeedbackConstants.CLOCK_TICK
            HostProtocol.Haptic.CONFIRM -> if (modern) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            HostProtocol.Haptic.REJECT -> if (modern) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
            HostProtocol.Haptic.LONG_PRESS -> HapticFeedbackConstants.LONG_PRESS
        }
        return view.performHapticFeedback(feedback)
    }

    override fun interceptBack(enabled: Boolean) {
        layerBack.isEnabled = enabled
    }

    override fun pushShortcut(id: String, label: String, path: String) {
        LauncherShortcuts.push(this, id, label, path)
    }

    private fun download(url: String, contentDisposition: String?, mimeType: String?) {
        val uri = url.toUri()
        val saver = app.files
        when {
            saver != null && uri.scheme == "https" ->
                saver.saveUrl(url, URLUtil.guessFileName(url, contentDisposition, mimeType), mimeType)
            uri.scheme == "https" || uri.scheme == "http" -> openExternally(uri)
            else -> toast(R.string.file_save_failed)
        }
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

    override suspend fun requestScreenCapture(): ScreenCaptureGrant? = preparing.withLock {
        val manager = getSystemService(MediaProjectionManager::class.java)
        // The whole display: a single app would break input coordinates.
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            manager.createScreenCaptureIntent()
        }
        val result = CompletableDeferred<ScreenCaptureGrant?>()
        pendingCapture = result
        screenCapture.launch(intent)
        result.await().also { pendingCapture = null }
    }

    override fun startSharing(spaceId: String, grant: ScreenCaptureGrant) {
        RuntimeService.share(this, spaceId, grant.resultCode, grant.data)
    }

    override fun openControlSettings(): Boolean = runCatching {
        if (isControlRestrictionAcknowledged()) {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            Toast.makeText(this, R.string.display_control_restricted, Toast.LENGTH_LONG).show()
        } else {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }.isSuccess

    /** Restricted and refused once, so App info now offers Allow restricted settings. */
    private fun isControlRestrictionAcknowledged(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        return runCatching {
            getSystemService(AppOpsManager::class.java)
                .unsafeCheckOpNoThrow(OP_ACCESS_RESTRICTED_SETTINGS, applicationInfo.uid, packageName) ==
                AppOpsManager.MODE_IGNORED
        }.getOrDefault(false)
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

        val destination = pending.redirectPath ?: "/"
        if (surface != null) WebWarmup.prefetch(destination)
        lifecycleScope.launch {
            runCatching { auth.completeSignIn(code, pending.challenge.verifier) }
                .onSuccess { hostPrefs.edit { remove(KEY_FORCE_LOGIN) } }
                .onFailure {
                    Log.w(TAG, "Sign-in failed", it)
                    toast(R.string.sign_in_failed)
                }
            navigate(destination)
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

        const val OP_ACCESS_RESTRICTED_SETTINGS = "android:access_restricted_settings"

        const val LAUNCH_TIMEOUT_MS = 2_500L
        const val SPLASH_FADE_MS = 180L
    }
}
