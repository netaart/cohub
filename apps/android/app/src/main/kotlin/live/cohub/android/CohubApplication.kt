package live.cohub.android

import android.app.Application
import live.cohub.android.auth.AuthConfig
import live.cohub.android.auth.AuthSession
import live.cohub.android.auth.CredentialStore
import live.cohub.android.runtime.DeviceRuntime

class CohubApplication : Application() {
    val auth: AuthSession by lazy {
        AuthSession(
            store = CredentialStore(this),
            config = AuthConfig(
                endpoint = BuildConfig.LOGTO_ENDPOINT,
                appId = BuildConfig.LOGTO_APP_ID,
                redirectUri = BuildConfig.OAUTH_REDIRECT_URI,
                apiResource = BuildConfig.LOGTO_API_RESOURCE,
            ),
            onAccountChanged = { signedIn -> if (signedIn) runtime.accountChanged() else runtime.stopAll() },
        )
    }

    val runtime: DeviceRuntime by lazy { DeviceRuntime(this) { auth.accountKey() } }
}
