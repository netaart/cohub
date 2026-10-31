package live.cohub.android.host

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class HostPermissions(
    private val activity: ComponentActivity,
    private val hasStorage: (() -> Boolean)?,
    private val requestStorage: suspend () -> Boolean,
) {
    private val prefs = activity.getSharedPreferences("cohub-permissions", Context.MODE_PRIVATE)
    private var pending: CompletableDeferred<Unit>? = null
    private val asking = Mutex()
    private val packageUri = "package:${activity.packageName}".toUri()

    private val ask: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { pending?.complete(Unit) }
    private val settings: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { pending?.complete(Unit) }

    fun status(): JsonObject = buildJsonObject {
        put("microphone", runtimeState(Manifest.permission.RECORD_AUDIO))
        put("camera", runtimeState(Manifest.permission.CAMERA))
        put("notifications", notificationState())
        hasStorage?.let { granted ->
            put("files", if (granted()) GRANTED else PROMPT)
            put("background", if (isUnrestricted()) GRANTED else PROMPT)
        }
    }

    suspend fun request(kind: String): String = when (kind) {
        "microphone" -> askFor(Manifest.permission.RECORD_AUDIO).let { runtimeState(Manifest.permission.RECORD_AUDIO) }
        "camera" -> askFor(Manifest.permission.CAMERA).let { runtimeState(Manifest.permission.CAMERA) }
        "notifications" -> requestNotifications()
        "files" -> if (requestStorage()) GRANTED else PROMPT
        "background" -> requestUnrestricted()
        else -> throw IllegalArgumentException("This permission cannot be requested")
    }

    suspend fun requestNotifications(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && notificationState() == PROMPT) {
            askFor(Manifest.permission.POST_NOTIFICATIONS)
        }
        return notificationState()
    }

    fun openSettings(kind: String): Boolean {
        val intent = when (kind) {
            "files" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, packageUri)
            } else {
                appDetails()
            }
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            "background" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "control" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "microphone", "camera" -> appDetails()
            else -> return false
        }
        return runCatching { activity.startActivity(intent) }.isSuccess
    }

    private fun appDetails() = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)

    private fun runtimeState(permission: String): String = when {
        activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED -> GRANTED
        prefs.getBoolean(permission, false) -> DENIED
        else -> PROMPT
    }

    private fun notificationState(): String = when {
        NotificationManagerCompat.from(activity).areNotificationsEnabled() -> GRANTED
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> runtimeState(Manifest.permission.POST_NOTIFICATIONS)
        else -> DENIED
    }

    private suspend fun askFor(permission: String) = asking.withLock {
        val result = CompletableDeferred<Unit>()
        pending = result
        ask.launch(permission)
        result.await()
        prefs.edit { putBoolean(permission, true) }
    }

    private fun isUnrestricted(): Boolean =
        activity.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(activity.packageName)

    @SuppressLint("BatteryLife")
    private suspend fun requestUnrestricted(): String {
        if (!isUnrestricted()) {
            asking.withLock {
                val result = CompletableDeferred<Unit>()
                pending = result
                settings.launch(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri))
                result.await()
            }
        }
        return if (isUnrestricted()) GRANTED else PROMPT
    }

    private companion object {
        const val GRANTED = "granted"
        const val DENIED = "denied"
        const val PROMPT = "prompt"
    }
}
