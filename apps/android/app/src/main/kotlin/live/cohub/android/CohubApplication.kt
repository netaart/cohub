package live.cohub.android

import android.app.Application
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import live.cohub.android.auth.Account
import live.cohub.android.auth.AuthConfig
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.SealedCredentialStore
import live.cohub.android.display.DeviceDisplay
import live.cohub.android.files.FileSaver
import live.cohub.android.host.LastPage
import live.cohub.android.host.LauncherShortcuts
import live.cohub.android.runtime.DeviceRuntime
import live.cohub.android.runtime.LocalWorkspaces
import live.cohub.android.runtime.RuntimeInstance
import okhttp3.OkHttpClient
import java.net.Proxy
import java.time.Duration

class CohubApplication : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val http: OkHttpClient by lazy { OkHttpClient() }

    val auth: AuthSession by lazy {
        AuthSession(
            store = SealedCredentialStore(this),
            config = AuthConfig(
                endpoint = BuildConfig.LOGTO_ENDPOINT,
                appId = BuildConfig.LOGTO_APP_ID,
                redirectUri = BuildConfig.OAUTH_REDIRECT_URI,
                apiResource = BuildConfig.LOGTO_API_RESOURCE,
            ),
            onAccountChanged = { previous, current ->
                runtime.accountChanged()
                if (previous is Account.SignedIn && current !is Account.SignedIn) {
                    display.stop()
                    runtime.stopAll()
                    lastPage.clear()
                    LauncherShortcuts.clear(this)
                }
            },
        )
    }

    val runtime: DeviceRuntime by lazy { DeviceRuntime(this) { (auth.account as? Account.SignedIn)?.key } }

    val workspaces: LocalWorkspaces by lazy {
        // Never a proxy (requests carry the Runtime's token), and no read limit: media pauses, big deletes take time.
        val loopback = http.newBuilder().proxy(Proxy.NO_PROXY).readTimeout(Duration.ZERO).build()
        LocalWorkspaces(loopback) { spaceId -> runtime.instances.value.any { it.spaceId == spaceId && it.state == RuntimeInstance.State.READY } }
    }

    val lastPage: LastPage by lazy { LastPage(this) }

    val display: DeviceDisplay by lazy { DeviceDisplay(this, scope) }

    val files: FileSaver? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) FileSaver(this, http, scope) { auth.accessToken() } else null
    }

    override fun onCreate() {
        super.onCreate()
        scope.launch { auth.load() }
    }
}
