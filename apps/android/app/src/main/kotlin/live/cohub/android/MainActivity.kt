package live.cohub.android

import android.app.AlertDialog
import android.app.AppOpsManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.widget.EditText
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.edit
import androidx.core.graphics.drawable.toDrawable
import androidx.core.net.toUri
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.doOnPreDraw
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.withStarted
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import live.cohub.android.auth.Account
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.AuthorizationRequest
import live.cohub.android.auth.GoogleSignIn
import live.cohub.android.auth.PendingSignIn
import live.cohub.android.auth.PendingSignIns
import live.cohub.android.auth.Pkce
import live.cohub.android.auth.SignInBrowser
import live.cohub.android.auth.SignInFlow
import live.cohub.android.files.FileChooser
import live.cohub.android.host.CancellationSignal
import live.cohub.android.host.HostActions
import live.cohub.android.host.HostBridge
import live.cohub.android.host.HostPermissions
import live.cohub.android.host.HostProtocol
import live.cohub.android.host.HostValues
import live.cohub.android.host.IncomingShare
import live.cohub.android.host.LastPage
import live.cohub.android.host.LaunchFailure
import live.cohub.android.host.LauncherShortcuts
import live.cohub.android.host.PageDialog
import live.cohub.android.host.PageDialogs
import live.cohub.android.host.ScreenCaptureGrant
import live.cohub.android.host.SurfaceListener
import live.cohub.android.host.WebOrigin
import live.cohub.android.host.WebSurface
import live.cohub.android.host.WebWarmup
import live.cohub.android.media.LocationAccess
import live.cohub.android.media.MediaCapture
import live.cohub.android.push.Push
import live.cohub.android.runtime.DeviceRuntime
import live.cohub.android.runtime.RuntimeService
import live.cohub.android.runtime.toJson
import live.cohub.android.ui.HostLocale
import live.cohub.android.ui.LaunchCover
import live.cohub.android.ui.ShellAppearance
import live.cohub.android.ui.SurfaceContainer
import kotlin.coroutines.resume

/** The shell: one WebView for product UI, one bridge for native capability. */
class MainActivity :
    ComponentActivity(),
    HostActions {

    private lateinit var auth: AuthSession
    private val runtime: DeviceRuntime? by lazy {
        if (BuildConfig.PLAY_BUILD) null else app.runtime
    }
    private lateinit var bridge: HostBridge
    private lateinit var lastPage: LastPage
    private lateinit var container: SurfaceContainer
    private lateinit var cover: LaunchCover
    private lateinit var appearance: ShellAppearance
    private lateinit var fileChooser: FileChooser
    private lateinit var mediaCapture: MediaCapture
    private lateinit var locationAccess: LocationAccess
    private lateinit var customTabs: ActivityResultLauncher<Intent>
    private lateinit var authTab: ActivityResultLauncher<Intent>
    private lateinit var allFilesAccess: ActivityResultLauncher<Intent>
    private lateinit var screenCapture: ActivityResultLauncher<Intent>
    private var pendingCapture: CompletableDeferred<ScreenCaptureGrant?>? = null
    private lateinit var hostPermissions: HostPermissions
    private var incomingShare: IncomingShare? = null

    @Volatile
    private var takenShare: IncomingShare? = null
    private val app get() = application as CohubApplication
    private val hostPrefs by lazy { getSharedPreferences("cohub-host", MODE_PRIVATE) }
    private val signIns by lazy { PendingSignIns(getSharedPreferences("cohub-sign-in", MODE_PRIVATE)) }
    private val signIn = SignInFlow { outcome -> bridge.emit(HostProtocol.Events.AUTH_FLOW, buildJsonObject { put("outcome", outcome) }) }
    private val google by lazy { GoogleSignIn(this, app.http) }
    private val pageDialogs = PageDialogs(::showPageDialog)
    private var leftForBrowser = false

    private var tabAttempt = 0
    private var pendingResult: CompletableDeferred<Unit>? = null
    private val preparing = Mutex()

    private var surface: WebSurface? = null
    private var startPath = "/"
    private var surfaceLost = false

    private var reportedDrawn = false
    private var committed = false
    private var revealDue = false
    private var crashedBeforeReady = false
    private var retryPath = "/"
    private var networkWatch: ConnectivityManager.NetworkCallback? = null

    private val revealTimeout = Runnable {
        revealDue = true
        if (committed) lift()
    }

    private val slowTimeout = Runnable { cover.show(LaunchCover.State.Slow) }

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
            app.display?.page?.value = null
            pageDialogs.dismiss()
            bridge.onNewDocument()
        }

        override fun onPageCommitted() {
            committed = true
            if (revealDue && cover.failure == null) lift()
        }

        override fun onLoadFailed(failure: LaunchFailure, url: Uri) = fail(failure, WebOrigin.pathOf(url) ?: startPath)

        override fun onNavigated(url: String) {
            historyBack.isEnabled = surface?.canGoBack() == true
            lastPage.remember(url)
        }

        override fun onRenderProcessGone(crashed: Boolean) = recoverSurface(crashed)

        override fun onShowFileChooser(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
            fileChooser.show(callback, params)

        override fun onPermissionRequest(request: PermissionRequest) = mediaCapture.onRequest(request)

        override fun onPermissionRequestCanceled(request: PermissionRequest) = mediaCapture.onCanceled(request)

        override fun onGeolocationPrompt(origin: String, callback: GeolocationPermissions.Callback) =
            locationAccess.onPrompt(origin, callback)

        override fun onGeolocationPromptHidden() = locationAccess.onHidden()

        override fun onDownload(url: String, contentDisposition: String?, mimeType: String?) =
            download(url, contentDisposition, mimeType)

        override fun onPageDialog(dialog: PageDialog) = pageDialogs.request(dialog)

        override fun onSharedFileRequest(request: WebResourceRequest): WebResourceResponse =
            IncomingShare.respond(takenShare, request, contentResolver)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen().setOnExitAnimationListener { splash ->
            cover.alignTo(splash.iconView)
            cover.doOnPreDraw { cover.post(splash::remove) }
            cover.invalidate()
        }
        super.onCreate(savedInstanceState)
        appearance = ShellAppearance(this)
        applyAppearance()

        auth = app.auth
        lastPage = app.lastPage
        bridge = HostBridge(
            scope = lifecycleScope,
            auth = auth,
            actions = this,
            runtime = runtime?.takeIf { it.available },
            files = app.files,
            display = app.display,
            workspaces = runtime?.takeIf { it.available }?.let { app.workspaces },
            pushToken = if (Push.configured) ({ Push.token(applicationContext) }) else null,
        )
        fileChooser = FileChooser(this)
        mediaCapture = MediaCapture(this)
        locationAccess = LocationAccess(this)

        // The authorization result returns as a redirect intent, not an activity
        customTabs = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val attempt = tabAttempt
            window.decorView.postDelayed({
                if (signIn.stage == SignInFlow.Stage.BROWSER) signIn.end(HostProtocol.AuthFlowOutcomes.CANCELED, attempt)
            }, TAB_CLOSED_GRACE_MS)
        }
        authTab = AuthTabIntent.registerActivityResultLauncher(this) { result ->
            when (result.resultCode) {
                AuthTabIntent.RESULT_OK -> result.resultUri?.let(::handleSignInRedirect) ?: signInFailed()
                AuthTabIntent.RESULT_CANCELED -> {
                    signIns.clear()
                    signIn.end(HostProtocol.AuthFlowOutcomes.CANCELED)
                }
                else -> signInFailed()
            }
        }
        allFilesAccess = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            pendingResult?.complete(Unit)
        }
        screenCapture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            pendingCapture?.complete(result.data?.takeIf { result.resultCode == RESULT_OK }?.let { ScreenCaptureGrant(result.resultCode, it) })
        }
        hostPermissions = HostPermissions(this, runtime?.takeIf { it.available }?.let { it::hasStorageAccess }, ::prepareRuntime)

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                runtime?.instances?.collect { bridge.emit(HostProtocol.Events.RUNTIME_CHANGED, it.toJson()) }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.display?.status?.collect { bridge.emit(HostProtocol.Events.DISPLAY_CHANGED, it.toJson()) }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.display?.opens?.collect { bridge.emit(HostProtocol.Events.DISPLAY_OPEN, it.toJson()) }
            }
        }

        addOnMultiWindowModeChangedListener { app.display?.phone?.multiWindow = it.isInMultiWindowMode }
        onBackPressedDispatcher.addCallback(this, historyBack)
        onBackPressedDispatcher.addCallback(this, layerBack)
        container = SurfaceContainer(this)
        setContentView(container)
        cover = LaunchCover(this, container) { start(retryPath) }
        addContentView(cover, ViewGroup.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // Recents replays the launching intent after a process death.
        val link = intent?.data?.takeIf {
            savedInstanceState == null && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
        }
        val fromRecents = (intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        val shared = savedInstanceState == null && !fromRecents && receiveShare(intent)
        startPath = if (shared) LauncherShortcuts.NEW_CHAT_PATH else link?.takeUnless(::isSignInRedirect)?.let(WebOrigin::pathOf) ?: lastPage.read() ?: "/"
        WebSurface.startUp(this) { if (!isDestroyed) start(startPath) }
        link?.takeIf(::isSignInRedirect)?.let(::handleSignInRedirect)
    }

    override fun onDestroy() {
        app.display?.page?.value = null
        pageDialogs.dismiss()
        bridge.onNewDocument()
        stopWaiting()
        container.removeAllViews()
        surface?.destroy()
        super.onDestroy()
    }

    private fun mountSurface(path: String) {
        WebWarmup.prefetch(path)
        val next = WebSurface(this, surfaceListener, runtime?.takeIf { it.available }?.let { app.workspaces })
        next.setBackgroundColor(appearance.backgroundColor)
        // Without the bridge the surface still runs on its browser path; this
        // only explains missing features.
        if (!bridge.attach(next.view, WebOrigin.uri)) {
            Toast.makeText(this, strings.getString(R.string.bridge_unavailable), Toast.LENGTH_LONG).show()
        }
        container.show(next.view)
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) next.pause()
        surface = next
        next.load(path)
    }

    private fun start(path: String) {
        stopWaiting()
        retryPath = path
        surfaceLost = false
        committed = false
        revealDue = false
        cover.show(LaunchCover.State.Loading)
        cover.postDelayed(revealTimeout, LAUNCH_TIMEOUT_MS)
        cover.postDelayed(slowTimeout, SLOW_TIMEOUT_MS)
        surface?.load(path) ?: mountSurface(path)
    }

    private fun lift() {
        stopWaiting()
        cover.dismiss()
    }

    private fun fail(failure: LaunchFailure, path: String) {
        stopWaiting()
        retryPath = path
        cover.show(LaunchCover.State.Failed(failure))
        if (failure == LaunchFailure.OFFLINE) watchNetwork()
    }

    private fun stopWaiting() {
        cover.removeCallbacks(revealTimeout)
        cover.removeCallbacks(slowTimeout)
        networkWatch?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        networkWatch = null
    }

    private fun watchNetwork() {
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val failed = connectivity.activeNetwork
        val watch = object : ConnectivityManager.NetworkCallback() {
            private var validated: Boolean? = null

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                val was = validated
                val now = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                validated = now
                if (now && (network != failed || was == false)) runOnUiThread { retryOffline() }
            }
        }
        connectivity.registerDefaultNetworkCallback(watch)
        networkWatch = watch
    }

    private fun retryOffline() {
        if (!isDestroyed && cover.failure == LaunchFailure.OFFLINE) start(retryPath)
    }

    private fun recoverSurface(crashed: Boolean) {
        val dead = surface ?: return
        surface = null
        pageDialogs.dismiss()
        bridge.onNewDocument()
        container.removeView(dead.view)
        dead.destroy()
        historyBack.isEnabled = false
        layerBack.isEnabled = false
        startPath = lastPage.read() ?: "/"
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            surfaceLost = true
            return
        }
        // Reloading a page that dies again before it is back would only loop; offer a restart from home.
        if (crashedBeforeReady) return fail(LaunchFailure.BROKEN, "/")
        crashedBeforeReady = true
        if (crashed) toast(R.string.web_view_recovering)
        start(startPath)
    }

    private fun navigate(path: String) {
        if (cover.failure != null) return start(path)
        retryPath = path
        surface?.load(path) ?: run { startPath = path }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch {
            auth.load()
            withStarted { runtime?.resume() }
        }
        if (surfaceLost) start(startPath) else retryOffline()
        surface?.resume()
        app.display?.phone?.multiWindow = isInMultiWindowMode
        bridge.emit(HostProtocol.Events.APP_FOREGROUND)
    }

    override fun onResume() {
        super.onResume()
        if (leftForBrowser && signIn.stage == SignInFlow.Stage.BROWSER) signIn.end(HostProtocol.AuthFlowOutcomes.CANCELED)
        leftForBrowser = false
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        relocalize()
    }

    override fun onStop() {
        if (signIn.stage == SignInFlow.Stage.BROWSER) leftForBrowser = true
        surface?.pause()
        bridge.emit(HostProtocol.Events.APP_BACKGROUND)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (receiveShare(intent)) return navigate(LauncherShortcuts.NEW_CHAT_PATH)
        val data = intent.data ?: return
        if (isSignInRedirect(data)) handleSignInRedirect(data) else WebOrigin.pathOf(data)?.let(::navigate)
    }

    private fun receiveShare(intent: Intent?): Boolean {
        if (intent == null || !IncomingShare.isShare(intent)) return false
        incomingShare = IncomingShare.from(intent, contentResolver) ?: return false
        return true
    }

    override fun hostId(): String = installId()

    override fun permissions(): HostPermissions = hostPermissions

    override fun takeShare(): IncomingShare? = incomingShare?.also {
        takenShare = it
        incomingShare = null
    }

    override suspend fun readSharedFile(id: String, index: Int): String {
        val share = takenShare?.takeIf { it.id == id } ?: throw IllegalStateException("That share is gone")
        return withContext(Dispatchers.IO) { share.readBase64(contentResolver, index) }
    }

    override fun startSignIn(redirectPath: String?, provider: String?): Boolean {
        if (provider == HostProtocol.SignInProviders.GOOGLE) {
            if (!signIn.begin(SignInFlow.Stage.GOOGLE)) return false
            lifecycleScope.launch {
                runCatching { signInWithGoogle(redirectPath) }.onFailure {
                    if (it is CancellationException) throw it
                    Log.w(TAG, "Google sign-in failed", it)
                    signInFailed()
                }
            }
            return true
        }
        if (!signIn.begin(SignInFlow.Stage.BROWSER)) return false
        if (!openSignInBrowser(redirectPath, provider)) throw CancellationSignal("No browser available to complete sign-in")
        return true
    }

    private suspend fun signInWithGoogle(redirectPath: String?) {
        val challenge = Pkce.create()
        val request = signIns.begin(challenge.verifier, BuildConfig.OAUTH_REDIRECT_URI, redirectPath)
        val result = google.signIn(request.state, request.redirectUri) { credential ->
            authorization(request, challenge, HostProtocol.SignInProviders.GOOGLE, credential)
        }
        when (result) {
            is GoogleSignIn.Result.Redirected -> handleSignInRedirect(result.uri)
            GoogleSignIn.Result.Canceled -> {
                signIns.clear()
                signIn.end(HostProtocol.AuthFlowOutcomes.CANCELED)
            }
            GoogleSignIn.Result.Failed -> signInFailed()
            GoogleSignIn.Result.Unavailable -> {
                signIn.advance(SignInFlow.Stage.BROWSER)
                if (!openSignInBrowser(redirectPath, HostProtocol.SignInProviders.GOOGLE)) signInFailed()
            }
        }
    }

    private fun openSignInBrowser(redirectPath: String?, provider: String?): Boolean {
        val browser = SignInBrowser.pick(this)
        val authTabBrowser = browser?.takeIf { it.authTab }
        val challenge = Pkce.create()
        val request = signIns.begin(
            verifier = challenge.verifier,
            redirectUri = if (authTabBrowser != null) AUTH_TAB_REDIRECT_URI else BuildConfig.OAUTH_REDIRECT_URI,
            redirectPath = redirectPath,
        )
        val url = authorization(request, challenge, provider)
        leftForBrowser = false
        try {
            if (authTabBrowser != null) {
                val tab = AuthTabIntent.Builder().build()
                tab.intent.setPackage(authTabBrowser.packageName)
                tab.launch(authTab, url, AUTH_TAB_SCHEME)
            } else {
                tabAttempt = signIn.attempt
                customTabs.launch(
                    CustomTabsIntent.Builder().build().intent.apply {
                        data = url
                        browser?.let { setPackage(it.packageName) }
                    },
                )
            }
        } catch (_: ActivityNotFoundException) {
            signIns.clear()
            signIn.end(HostProtocol.AuthFlowOutcomes.FAILED)
            return false
        }
        return true
    }

    private fun authorization(request: PendingSignIn, challenge: Pkce.Challenge, provider: String?, googleCredential: String? = null): Uri =
        AuthorizationRequest.build(
            BuildConfig.LOGTO_ENDPOINT,
            AuthorizationRequest.parameters(
                appId = BuildConfig.LOGTO_APP_ID,
                redirectUri = request.redirectUri,
                resource = BuildConfig.LOGTO_API_RESOURCE,
                challenge = challenge,
                state = request.state,
                forceLogin = hostPrefs.getBoolean(KEY_FORCE_LOGIN, false),
                provider = provider,
                googleCredential = googleCredential,
            ),
        )

    override suspend fun signOut() {
        hostPrefs.edit { putBoolean(KEY_FORCE_LOGIN, true) }
        withTimeoutOrNull(3_000) { Push.forget(applicationContext) }
        auth.signOut()
        google.forget()
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
        val url = path.toUri()
        require(url.scheme?.lowercase() in HostProtocol.EXTERNAL_SCHEMES) { "navigation.openPath cannot open ${url.scheme}: links" }
        openExternally(url)
    }

    override fun setLocale(locale: String?) {
        if (HostLocale.set(this, locale)) relocalize()
    }

    private fun relocalize() {
        cover.relocalize()
        if (reportedDrawn && auth.account is Account.SignedIn) LauncherShortcuts.pushNewChat(this)
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
        crashedBeforeReady = false
        lift()
        if (reportedDrawn) return
        reportedDrawn = true
        reportFullyDrawn()
        if (auth.account is Account.SignedIn) LauncherShortcuts.pushNewChat(this)
    }

    override fun showAbout(web: String?) {
        val version = listOf(BuildConfig.VERSION_NAME, BuildConfig.COMMIT).filter { it.isNotEmpty() }.joinToString(" · ")
        val strings = strings
        val cli = if (runtime?.cli?.bundled == true) BuildConfig.CLI_VERSION else strings.getString(R.string.about_cli_unavailable)
        AlertDialog.Builder(this)
            .setTitle(strings.getString(R.string.about_title))
            .setMessage(strings.getString(R.string.about_message, version, web.orEmpty(), cli))
            .setPositiveButton(strings.getString(R.string.dialog_ok), null)
            .setNeutralButton(strings.getString(R.string.about_source)) { _, _ -> openExternally(REPOSITORY.toUri()) }
            .show()
    }

    override fun performHaptic(kind: HostValues.Haptic): Boolean {
        val view = surface?.view ?: return false
        val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val feedback = when (kind) {
            HostValues.Haptic.TICK -> HapticFeedbackConstants.CLOCK_TICK
            HostValues.Haptic.CONFIRM -> if (modern) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            HostValues.Haptic.REJECT -> if (modern) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
            HostValues.Haptic.LONG_PRESS -> HapticFeedbackConstants.LONG_PRESS
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
        val runtime = runtime ?: return@withLock false
        if (!confirmRuntimeConsent(runtime)) return@withLock false
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

    private suspend fun confirmRuntimeConsent(runtime: DeviceRuntime): Boolean {
        if (hostPrefs.getBoolean(KEY_RUNTIME_CONSENT, false)) return true
        val allowed = runtime.instances.value.isNotEmpty() || suspendCancellableCoroutine { result ->
            val strings = strings
            val dialog = AlertDialog.Builder(this)
                .setTitle(strings.getString(R.string.runtime_consent_title))
                .setMessage(strings.getString(R.string.runtime_consent_message))
                .setPositiveButton(strings.getString(R.string.runtime_consent_allow)) { _, _ -> result.resume(true) }
                .setNegativeButton(strings.getString(R.string.dialog_cancel)) { _, _ -> result.resume(false) }
                .setOnCancelListener { result.resume(false) }
                .show()
            result.invokeOnCancellation { dialog.dismiss() }
        }
        if (allowed) hostPrefs.edit { putBoolean(KEY_RUNTIME_CONSENT, true) }
        return allowed
    }

    override fun openPhoneControlSettings(intent: Intent): Boolean = runCatching {
        startActivity(if (isInMultiWindowMode) intent.addFlags(Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT) else intent)
    }.isSuccess

    override suspend fun requestScreenCapture(): ScreenCaptureGrant? = preparing.withLock {
        val manager = getSystemService(MediaProjectionManager::class.java)
        // The whole screen: one app alone would move every input off target.
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            manager.createScreenCaptureIntent()
        }
        val result = CompletableDeferred<ScreenCaptureGrant?>()
        pendingCapture = result
        try {
            screenCapture.launch(intent)
            result.await()
        } finally {
            pendingCapture = null
        }
    }

    override fun startSharing(spaceId: String, grant: ScreenCaptureGrant) = RuntimeService.share(this, spaceId, grant)

    override fun openControlSettings(): Boolean = runCatching {
        if (isControlRestrictionAcknowledged()) {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            Toast.makeText(this, strings.getString(R.string.display_control_restricted), Toast.LENGTH_LONG).show()
        } else {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }.isSuccess

    /** Restricted and refused once, so App info now offers Allow restricted settings. */
    private fun isControlRestrictionAcknowledged(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        return runCatching {
            @Suppress("DEPRECATION") // The restricted-settings op has no other public read.
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

    private fun isSignInRedirect(data: Uri): Boolean = data.withoutQuery() == BuildConfig.OAUTH_REDIRECT_URI

    private fun Uri.withoutQuery(): String = buildUpon().clearQuery().fragment(null).build().toString()

    private fun handleSignInRedirect(data: Uri) {
        val pending = signIns.take(data.getQueryParameter("state"))
            ?.takeIf { data.withoutQuery() == it.redirectUri }
        val code = data.getQueryParameter("code")
        if (pending == null || code == null) {
            if (auth.account !is Account.SignedIn) toast(R.string.sign_in_failed)
            signIn.end(HostProtocol.AuthFlowOutcomes.FAILED)
            return
        }

        signIn.advance(SignInFlow.Stage.EXCHANGE)
        val destination = pending.redirectPath ?: "/"
        if (surface != null) WebWarmup.prefetch(destination)
        lifecycleScope.launch {
            runCatching { auth.completeSignIn(code, pending.verifier, pending.redirectUri) }
                .onSuccess {
                    hostPrefs.edit { remove(KEY_FORCE_LOGIN) }
                    signIn.end(HostProtocol.AuthFlowOutcomes.SIGNED_IN)
                }
                .onFailure {
                    Log.w(TAG, "Sign-in failed", it)
                    signInFailed()
                }
            navigate(destination)
        }
    }

    private fun signInFailed() {
        toast(R.string.sign_in_failed)
        signIn.end(HostProtocol.AuthFlowOutcomes.FAILED)
    }

    private fun showPageDialog(dialog: PageDialog): () -> Unit {
        if (isFinishing || isDestroyed) {
            dialog.settle(false)
            return {}
        }
        val strings = strings
        val leaving = dialog.kind == PageDialog.Kind.BEFORE_UNLOAD
        val input = if (dialog.kind != PageDialog.Kind.PROMPT) {
            null
        } else {
            EditText(this).apply {
                setText(dialog.defaultText)
                setSingleLine()
                selectAll()
            }
        }
        val builder = AlertDialog.Builder(this)
            .setTitle(dialog.title)
            .setMessage(if (leaving) strings.getString(R.string.dialog_leave_message) else dialog.message)
            .setPositiveButton(strings.getString(if (leaving) R.string.dialog_leave else R.string.dialog_ok)) { _, _ ->
                dialog.settle(true, input?.text?.toString())
            }
            .setOnDismissListener { dialog.settle(false) }
        if (dialog.kind != PageDialog.Kind.ALERT) builder.setNegativeButton(strings.getString(R.string.dialog_cancel), null)
        val shown = builder.create()
        if (input != null) {
            val margin = (DIALOG_INPUT_MARGIN_DP * resources.displayMetrics.density).toInt()
            shown.setView(input, margin, 0, margin, 0)
            shown.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        }
        shown.show()
        return shown::dismiss
    }

    private fun toast(messageRes: Int) {
        Toast.makeText(this, strings.getString(messageRes), Toast.LENGTH_SHORT).show()
    }

    private val strings get() = HostLocale.strings(this)

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
        const val TAB_CLOSED_GRACE_MS = 1_000L
        const val KEY_INSTALL_ID = "install_id"
        const val KEY_FORCE_LOGIN = "force_login"
        const val KEY_RUNTIME_CONSENT = "runtime_consent"

        // An Auth Tab returns only to the app that opened it, so no other app can claim this scheme.
        const val AUTH_TAB_SCHEME = BuildConfig.APPLICATION_ID
        const val AUTH_TAB_REDIRECT_URI = "$AUTH_TAB_SCHEME://auth/callback"
        const val REPOSITORY = "https://github.com/netaart/cohub"

        const val OP_ACCESS_RESTRICTED_SETTINGS = "android:access_restricted_settings"

        const val DIALOG_INPUT_MARGIN_DP = 20

        const val LAUNCH_TIMEOUT_MS = 2_500L
        const val SLOW_TIMEOUT_MS = 8_000L
    }
}
