package live.cohub.android

import android.app.Application
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import live.cohub.android.auth.AuthConfig
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.EncryptedCredentialStore
import live.cohub.android.files.FileSaver
import live.cohub.android.host.LastPage
import live.cohub.android.host.LauncherShortcuts
import live.cohub.android.runtime.DeviceRuntime
import okhttp3.OkHttpClient

class CohubApplication : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val http: OkHttpClient by lazy { OkHttpClient() }

    val auth: AuthSession by lazy {
        AuthSession(
            store = EncryptedCredentialStore(this),
            config = AuthConfig(
                endpoint = BuildConfig.LOGTO_ENDPOINT,
                appId = BuildConfig.LOGTO_APP_ID,
                redirectUri = BuildConfig.OAUTH_REDIRECT_URI,
                apiResource = BuildConfig.LOGTO_API_RESOURCE,
            ),
            onAccountChanged = { signedIn ->
                if (signedIn) {
                    runtime.accountChanged()
                } else {
                    runtime.stopAll()
                    lastPage.clear()
                    LauncherShortcuts.clear(this)
                }
            },
        )
    }

    val runtime: DeviceRuntime by lazy { DeviceRuntime(this) { auth.accountKey() } }

    val lastPage: LastPage by lazy { LastPage(this) }

    val files: FileSaver? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) FileSaver(this, http, scope) { auth.accessToken() } else null
    }

    override fun onCreate() {
        super.onCreate()
        scope.launch(Dispatchers.IO) { auth.preload() }
    }
}
