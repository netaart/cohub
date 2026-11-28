package live.cohub.android.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import live.cohub.android.BuildConfig
import kotlin.coroutines.resume

object Push {
    val configured: Boolean
        get() = listOf(BuildConfig.FCM_APP_ID, BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_SENDER_ID).all { it.isNotEmpty() }

    fun ensureApp(context: Context) {
        if (!configured || FirebaseApp.getApps(context).isNotEmpty()) return
        FirebaseApp.initializeApp(
            context.applicationContext,
            FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APP_ID)
                .setProjectId(BuildConfig.FCM_PROJECT_ID)
                .setApiKey(BuildConfig.FCM_API_KEY)
                .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                .build(),
        )
    }

    suspend fun forget(context: Context) {
        if (!configured) return
        runCatching {
            ensureApp(context)
            suspendCancellableCoroutine { continuation ->
                FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { continuation.resume(Unit) }
            }
        }
    }

    suspend fun token(context: Context): String? {
        if (!configured) return null
        return runCatching {
            ensureApp(context)
            suspendCancellableCoroutine { continuation ->
                FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                    continuation.resume(if (task.isSuccessful) task.result else null)
                }
            }
        }.getOrNull()
    }
}
