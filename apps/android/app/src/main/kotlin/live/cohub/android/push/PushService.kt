package live.cohub.android.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.net.toUri
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import live.cohub.android.CohubApplication
import live.cohub.android.MainActivity
import live.cohub.android.R
import live.cohub.android.host.WebOrigin

class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data["title"]?.takeIf { it.isNotBlank() } ?: return
        val path = data["path"]?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/spaces/inbox"
        val tag = data["tag"] ?: data["id"] ?: path
        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return
        val auth = (application as CohubApplication).auth
        val signedIn = runBlocking { auth.status() }
        if (!signedIn.authenticated || signedIn.subject != data["subject"]) return
        ensureChannel()
        val open = PendingIntent.getActivity(
            this,
            tag.hashCode(),
            Intent(this, MainActivity::class.java).setData(WebOrigin.urlOf(path).toUri()).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_runtime)
            .setContentTitle(title)
            .setContentText(data["body"])
            .setStyle(NotificationCompat.BigTextStyle().bigText(data["body"]))
            .setNumber(data["unread"]?.toIntOrNull() ?: 0)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        runCatching { manager.notify(tag, 0, notification) }
    }

    override fun onNewToken(token: String) = Unit

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.notifications_channel), NotificationManager.IMPORTANCE_HIGH))
    }

    private companion object {
        const val CHANNEL_ID = "notifications"
    }
}
