package live.cohub.android.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import live.cohub.android.BuildConfig
import live.cohub.android.CohubApplication
import live.cohub.android.MainActivity
import live.cohub.android.R
import live.cohub.android.auth.Account
import live.cohub.android.display.DisplayStatus
import live.cohub.android.host.WebOrigin
import java.io.File
import java.util.UUID

private const val TAG = "CohubRuntime"

class RuntimeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val app: CohubApplication get() = application as CohubApplication

    private val sessions = mutableMapOf<String, Session>()
    private var watching: Job? = null
    private val networkAvailable = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            networkAvailable.tryEmit(Unit)
        }
    }

    private class Session(val root: String, val job: Job)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = app.runtime
        when (intent?.action) {
            ACTION_STOP_ALL -> {
                app.display?.stop()
                runtime.stopAll()
                return START_NOT_STICKY
            }
            ACTION_STOP_SHARING -> {
                app.display?.stop()
                return START_STICKY
            }
        }
        createChannel()
        if (!enterForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (watching == null) {
            getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
            watching = scope.launch(Dispatchers.Main.immediate) {
                app.auth.load()
                runtime.enabled.collect(::reconcile)
            }
            scope.launch {
                combine(runtime.instances, app.display?.status ?: flowOf(null)) { instances, display -> instances to display }
                    .collect { (instances, display) -> showNotification(instances, display) }
            }
        }
        return START_STICKY
    }

    private fun enterForeground(): Boolean = try {
        val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(app.runtime.instances.value, app.display?.status?.value), types)
        true
    } catch (error: RuntimeException) {
        Log.w(TAG, "Runtime could not enter the foreground", error)
        false
    }

    override fun onDestroy() {
        if (watching != null) runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        app.display?.stop()
        scope.cancel()
        app.runtime.clearLive()
        super.onDestroy()
    }

    private fun reconcile(wanted: List<Binding>) {
        val runtime = app.runtime
        app.display?.status?.value?.sharedWith?.let { shared -> if (wanted.none { it.spaceId == shared }) app.display?.stop() }
        if (wanted.isEmpty() || !runtime.hasStorageAccess()) {
            if (wanted.isNotEmpty()) runtime.storageDenied()
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
        val home = File(filesDir, "runtime/$spaceId")
        val displaySocket = File(home, "display.sock")
        val token: suspend (Boolean) -> String = { force ->
            auth.accessToken(force) ?: if (auth.account is Account.SignedIn) {
                error("Access token unavailable")
            } else {
                throw RuntimeRejected(RuntimeRejected.SIGNED_OUT)
            }
        }
        val connection = RuntimeConnection(
            client = app.http,
            url = "${BuildConfig.GATEWAY_ORIGIN}/runtime/relay",
            spaceId = spaceId,
            runtimeId = runtimeId,
            token = token,
            networkAvailable = networkAvailable,
        )
        val bridge = SandboxBridge(
            binary = runtime.bridgeBinary,
            root = File(binding.root),
            home = home,
            spaceId = spaceId,
            relayUrl = "${BuildConfig.GATEWAY_ORIGIN}/sandbox/relay",
            runtimeId = runtimeId,
            displaySocket = displaySocket,
            token = { token(false) },
            onEndpoint = { app.workspaces.update(spaceId, it) },
        )
        runtime.publish(spaceId, RuntimeInstance.State.CONNECTING)
        val reporter = launch {
            combine(connection.ready, bridge.connected) { ready, connected -> ready && connected }
                .collect { ready ->
                    runtime.publish(spaceId, if (ready) RuntimeInstance.State.READY else RuntimeInstance.State.CONNECTING)
                }
        }
        app.display?.provide(this, spaceId, displaySocket)
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

    private fun showNotification(instances: List<RuntimeInstance>, display: DisplayStatus?) {
        if (instances.none { it.state == RuntimeInstance.State.CONNECTING || it.state == RuntimeInstance.State.READY }) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(instances, display))
    }

    private fun notification(instances: List<RuntimeInstance>, display: DisplayStatus?): Notification {
        val ready = instances.count { it.state == RuntimeInstance.State.READY }
        val sharing = display?.sharedWith != null
        val text = when {
            sharing -> getString(R.string.display_sharing_control)
            ready > 0 -> resources.getQuantityString(R.plurals.runtime_ready, ready, ready)
            else -> getString(R.string.runtime_connecting)
        }
        val only = instances.singleOrNull { it.state == RuntimeInstance.State.READY || it.state == RuntimeInstance.State.CONNECTING }
        val destination = Intent(this, MainActivity::class.java).apply {
            only?.let { data = WebOrigin.urlOf("/spaces/${it.spaceId}").toUri() }
        }
        val open = PendingIntent.getActivity(
            this, 0, destination, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RuntimeService::class.java).setAction(ACTION_STOP_ALL), PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_runtime)
            .setContentTitle(getString(R.string.runtime_title))
            .setContentText(text)
            .setContentIntent(open)
        if (sharing) {
            val stopSharing = PendingIntent.getService(
                this, 2, Intent(this, RuntimeService::class.java).setAction(ACTION_STOP_SHARING), PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, getString(R.string.display_stop), stopSharing)
        }
        return builder
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

    companion object {
        private const val CHANNEL_ID = "runtime"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP_ALL = "live.cohub.android.runtime.STOP_ALL"
        private const val ACTION_STOP_SHARING = "live.cohub.android.runtime.STOP_SHARING"
    }
}
