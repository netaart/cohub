package live.cohub.android.auth

import android.content.Context
import androidx.browser.customtabs.CustomTabsClient

/** Only the default browser is trusted with credentials. */
data class SignInBrowser(val packageName: String, val authTab: Boolean) {
    companion object {
        fun pick(context: Context): SignInBrowser? {
            val packageName = CustomTabsClient.getPackageName(context, null) ?: return null
            return SignInBrowser(packageName, CustomTabsClient.isAuthTabSupported(context, packageName))
        }
    }
}
