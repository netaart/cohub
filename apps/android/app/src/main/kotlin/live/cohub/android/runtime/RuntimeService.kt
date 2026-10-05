package live.cohub.android.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import live.cohub.android.BuildConfig
import live.cohub.android.CohubApplication
import live.cohub.android.MainActivity
import live.cohub.android.R
import okhttp3.OkHttpClient
import java.io.File
import java.util.UUID

private const val TAG = "CohubRuntime"

class RuntimeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val app: CohubApplication get() = application as CohubApplication

    private val sessions = mutableMapOf<String, Session>()
    private var watching: Job? = null

    private class Session(val root: String, val job: Job)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = app.runtime
        if (intent?.action == ACTION_STOP_ALL) {
            runtime.stopAll()
            return START_NOT_STICKY
        }
        createChannel()
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(runtime.instances.value),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
            )
        } catch (error: IllegalStateException) {
            Log.w(TAG, "Runtime could not enter the foreground", error)
            stopSelf()
            return START_NOT_STICKY
        }
        if (watching == null) {
            watching = scope.launch(Dispatchers.Main.immediate) { runtime.enabled.collect(::reconcile) }
            scope.launch { runtime.instances.collect(::showNotification) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        app.runtime.clearLive()
        super.onDestroy()
    }

    private fun reconcile(wanted: List<Binding>) {
        val runtime = app.runtime
        if (wanted.isEmpty() || !runtime.hasStorageAccess()) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        val roots = wanted.associate { it.spaceId to it.root }
        val retired = sessions.filter { (spaceId, session) -> roots[spaceId] != session.root }
        retired.forEach { (spaceId, session) ->
            session.job.cancel()
            sessions.remove(spaceId)
        }
        for (binding in wanted) {
            if (binding.spaceId in sessions) continue
            val previous = retired[binding.spaceId]?.job
            sessions[binding.spaceId] = Session(
                binding.root,
                scope.launch {
                    previous?.join()
                    serve(binding)
                },
            )
        }
    }

    private suspend fun serve(binding: Binding) = coroutineScope {
        val runtime = app.runtime
        val auth = app.auth
        val spaceId = binding.spaceId
        val runtimeId = UUID.randomUUID().toString()
        val token: suspend (Boolean) -> String = { force ->
            auth.accessToken(force) ?: if (auth.hasCredentials()) {
                error("Access token unavailable")
            } else {
                throw RuntimeRejected(RuntimeRejected.SIGNED_OUT)
            }
        }
        val connection = RuntimeConnection(
            client = http,
            url = "${BuildConfig.GATEWAY_ORIGIN}/runtime/relay",
            spaceId = spaceId,
            runtimeId = runtimeId,
            token = token,
        )
        val bridge = SandboxBridge(
            binary = runtime.bridgeBinary,
            root = File(binding.root),
            home = File(filesDir, "runtime/$spaceId"),
            spaceId = spaceId,
            relayUrl = "${BuildConfig.GATEWAY_ORIGIN}/sandbox/relay",
            runtimeId = runtimeId,
            token = { token(false) },
        )
        runtime.publish(spaceId, RuntimeInstance.State.CONNECTING)
        val reporter = launch {
            combine(connection.ready, bridge.connected) { ready, connected -> ready && connected }
                .collect { ready ->
                    runtime.publish(spaceId, if (ready) RuntimeInstance.State.READY else RuntimeInstance.State.CONNECTING)
                }
        }
        launch { bridge.run(connection.ready) }
        try {
            connection.run()
        } catch (error: RuntimeRejected) {
            Log.w(TAG, "Runtime rejected for $spaceId", error)
            reporter.cancelAndJoin()
            runtime.fail(spaceId, error.code)
            coroutineContext.cancelChildren()
        }
    }

    private fun showNotification(instances: List<RuntimeInstance>) {
        if (instances.none { it.state == RuntimeInstance.State.CONNECTING || it.state == RuntimeInstance.State.READY }) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(instances))
    }

    private fun notification(instances: List<RuntimeInstance>): Notification {
        val ready = instances.count { it.state == RuntimeInstance.State.READY }
        val text = if (ready > 0) {
            resources.getQuantityString(R.plurals.runtime_ready, ready, ready)
        } else {
            getString(R.string.runtime_connecting)
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RuntimeService::class.java).setAction(ACTION_STOP_ALL), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_runtime)
            .setContentTitle(getString(R.string.runtime_title))
            .setContentText(text)
            .setContentIntent(open)
            .addAction(0, getString(R.string.runtime_disconnect), stop)
            .setOngoing(true)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.runtime_channel), NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private companion object {
        val http by lazy { OkHttpClient() }
        const val CHANNEL_ID = "runtime"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP_ALL = "live.cohub.android.runtime.STOP_ALL"
    }
}
