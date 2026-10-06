package live.cohub.android

import android.app.Application
import live.cohub.android.auth.AuthConfig
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.EncryptedCredentialStore
import live.cohub.android.host.LastPage
import live.cohub.android.runtime.DeviceRuntime

class CohubApplication : Application() {
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
                }
            },
        )
    }

    val runtime: DeviceRuntime by lazy { DeviceRuntime(this) { auth.accountKey() } }

    val lastPage: LastPage by lazy { LastPage(this) }
}
