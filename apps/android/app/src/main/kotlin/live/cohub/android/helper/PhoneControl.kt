package live.cohub.android.helper

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Binder
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import live.cohub.android.R
import live.cohub.android.auth.CredentialCipher
import live.cohub.android.auth.KeystoreKey
import live.cohub.android.display.ControlService
import live.cohub.android.helper.adb.Adb
import live.cohub.android.helper.adb.AdbKey
import live.cohub.android.helper.adb.AdbPairing
import java.io.File
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.Base64
import kotlin.coroutines.resume

@SuppressLint("NewApi")
class PhoneControl(private val context: Context, private val scope: CoroutineScope) {
    enum class Stage(val wire: String) { OFF("off"), PAIRING("pairing"), STARTING("starting"), READY("ready"), STOPPED("stopped") }

    data class State(val stage: Stage, val error: String? = null) {
        fun toJson(): JsonObject = buildJsonObject {
            put("stage", stage.wire)
            put("error", error)
        }
    }

    private val keyFile = File(context.noBackupFilesDir, "helper/adb.key")
    private val prefs = context.getSharedPreferences("phone_control", Context.MODE_PRIVATE)
    private val cipher = CredentialCipher(KeystoreKey("live.cohub.android.adb"))
    private val starting = Mutex()
    private val token = Binder()
    @Volatile private var nonce: String? = null
    private var pairing: Job? = null

    private val _helper = MutableStateFlow<ICohubHelper?>(null)
    val helper: StateFlow<ICohubHelper?> = _helper.asStateFlow()

    private val _state = MutableStateFlow(State(initialStage()))
    val state: StateFlow<State> = _state.asStateFlow()

    private val paired: Boolean get() = prefs.getBoolean(PAIRED, false) && keyFile.isFile

    private fun initialStage() = if (prefs.getBoolean(PAIRED, false)) Stage.STOPPED else Stage.OFF

    init {
        if (_state.value.stage == Stage.STOPPED) watchWifi()
    }

    internal fun attach(extras: Bundle): Bundle? {
        val expected = nonce ?: return null
        if (extras.getString(HelperHandoff.KEY_NONCE) != expected) return null
        val binder = extras.getBinder(HelperHandoff.KEY_HELPER) ?: return null
        val helper = ICohubHelper.Stub.asInterface(binder)
        nonce = null
        try {
            binder.linkToDeath({
                if (_helper.compareAndSet(helper, null)) {
                    _state.value = State(Stage.STOPPED, "helper_stopped")
                    scope.launch {
                        delay(RESTART_MS)
                        start()
                    }
                }
            }, 0)
        } catch (_: Exception) {
            return null
        }
        _helper.value = helper
        _state.value = State(Stage.READY)
        scope.launch(Dispatchers.IO) { prepare(helper) }
        return Bundle().apply { putBinder(HelperHandoff.KEY_APP, token) }
    }

    private fun prepare(helper: ICohubHelper) {
        runCatching { helper.prepare() }
        if (prefs.getBoolean(PREPARED, false)) return
        if (enableControl()) prefs.edit { putBoolean(PREPARED, true) }
    }

    fun enableControl(): Boolean {
        if (!canWriteSecureSettings()) return false
        val resolver = context.contentResolver
        val service = ComponentName(context, ControlService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        if (service !in enabled.split(':')) {
            Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, listOf(enabled, service).filter { it.isNotEmpty() }.joinToString(":"))
        }
        Settings.Secure.putInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
        return true
    }

    private fun canWriteSecureSettings() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    fun start() {
        if (!paired || _helper.value != null) return
        scope.launch(Dispatchers.IO) {
            starting.withLock {
                if (_helper.value != null) return@withLock
                _state.value = State(Stage.STARTING)
                val error = launchHelper()
                if (error != null && _helper.value == null) _state.value = State(if (error == "unpaired") Stage.OFF else Stage.STOPPED, error)
            }
        }
    }

    private suspend fun launchHelper(): String? {
        val key = key() ?: return "unpaired"
        if (canWriteSecureSettings()) runCatching { Settings.Global.putInt(context.contentResolver, ADB_WIFI_ENABLED, 1) }
        if (Settings.Global.getInt(context.contentResolver, ADB_WIFI_ENABLED, 0) != 1) return "wireless_debugging_off"
        val next = token()
        nonce = next
        val info = context.applicationInfo
        val command = "CLASSPATH=${info.sourceDir} setsid app_process /system/bin --nice-name=${context.packageName}:helper " +
            "${HelperMain::class.java.name} ${context.packageName} ${info.uid} $next </dev/null >/dev/null 2>&1 &"
        val last = prefs.getInt(PORT, 0)
        val ran = (last > 0 && exec(key, last, command)) || findPort(CONNECT_SERVICE, FIND_MS)?.takeIf { it != last }?.let { exec(key, it, command) } == true
        if (!ran) return if (key() == null) "unpaired" else "wireless_debugging_unreachable"
        return if (withTimeoutOrNull(ATTACH_MS) { _helper.first { it != null } } != null) null else "helper_did_not_start"
    }

    private fun exec(key: AdbKey, port: Int, command: String): Boolean = try {
        Adb.exec(key, port, command)
        prefs.edit { putInt(PORT, port) }
        true
    } catch (error: Adb.Unauthorized) {
        prefs.edit { putBoolean(PAIRED, false) }
        keyFile.delete()
        false
    } catch (error: Exception) {
        Log.i(TAG, "adbd is not on port $port: ${error.message}")
        false
    }

    fun setup() {
        if (_state.value.stage == Stage.READY) return
        if (paired) return start()
        _state.value = State(Stage.PAIRING)
        pairing?.cancel()
        pairing = scope.launch(Dispatchers.IO) {
            val found = withTimeoutOrNull(PAIRING_MS) {
                var port: Int? = null
                while (port == null) port = findPort(PAIRING_SERVICE, FIND_MS)
                port
            }
            if (found == null) {
                _state.value = State(if (paired) Stage.STOPPED else Stage.OFF, "pairing_timed_out")
                return@launch
            }
            prefs.edit { putInt(PAIRING_PORT, found) }
            notifyPairing(null)
        }
    }

    internal fun pair(code: String) {
        scope.launch(Dispatchers.IO) {
            val key = key(create = true) ?: return@launch
            val port = prefs.getInt(PAIRING_PORT, 0)
            val result = runCatching { AdbPairing.pair(key, port, code.filter(Char::isDigit)) }
            if (result.isFailure) {
                Log.i(TAG, "pairing failed", result.exceptionOrNull())
                val again = findPort(PAIRING_SERVICE, FIND_MS)
                if (again != null) prefs.edit { putInt(PAIRING_PORT, again) }
                notifyPairing(context.getString(if (again == null) R.string.phone_control_pairing_closed else R.string.phone_control_pairing_wrong))
                return@launch
            }
            prefs.edit { putBoolean(PAIRED, true).putBoolean(PREPARED, false) }
            notifications().cancel(NOTIFICATION_ID)
            pairing?.cancel()
            _state.value = State(Stage.STOPPED)
            start()
            watchWifi()
        }
    }

    private fun key(create: Boolean = false): AdbKey? {
        keyFile.takeIf { it.isFile }?.let { file ->
            runCatching { return AdbKey.of(cipher.open(file.readBytes())) }
            if (!create) return null
        }
        if (!create) return null
        return AdbKey.generate().also { key ->
            keyFile.parentFile?.mkdirs()
            keyFile.writeBytes(cipher.seal(key.pkcs8))
        }
    }

    private var watchingWifi = false

    private fun watchWifi() {
        if (watchingWifi) return
        watchingWifi = true
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        context.getSystemService(ConnectivityManager::class.java).registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = start()
        })
    }

    private suspend fun findPort(type: String, timeoutMs: Long): Int? {
        val nsd = context.getSystemService(NsdManager::class.java)
        return withTimeoutOrNull(timeoutMs) {
            callbackFlow {
                val listener = object : NsdManager.DiscoveryListener {
                    override fun onServiceFound(service: NsdServiceInfo) {
                        trySend(service)
                    }
                    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                        close()
                    }
                    override fun onDiscoveryStarted(serviceType: String) = Unit
                    override fun onDiscoveryStopped(serviceType: String) = Unit
                    override fun onServiceLost(service: NsdServiceInfo) = Unit
                    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
                }
                nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
                awaitClose { runCatching { nsd.stopServiceDiscovery(listener) } }
            }.mapNotNull { resolve(nsd, it) }.firstOrNull()
        }
    }

    @Suppress("DEPRECATION")
    private suspend fun resolve(nsd: NsdManager, service: NsdServiceInfo): Int? = withTimeoutOrNull(RESOLVE_MS) {
        suspendCancellableCoroutine { continuation ->
            nsd.resolveService(service, object : NsdManager.ResolveListener {
                override fun onServiceResolved(info: NsdServiceInfo) {
                    val own = info.host?.let { it.isLoopbackAddress || NetworkInterface.getByInetAddress(it) != null } == true
                    continuation.resume(if (own) info.port else null)
                }
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = continuation.resume(null)
            })
        }
    }

    private fun notifyPairing(problem: String?) {
        val manager = notifications()
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, context.getString(R.string.phone_control_channel), NotificationManager.IMPORTANCE_HIGH))
        val reply = PendingIntent.getBroadcast(
            context, 0, Intent(context, PairingReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val input = RemoteInput.Builder(KEY_CODE).setLabel(context.getString(R.string.phone_control_pairing_code)).build()
        val action = NotificationCompat.Action.Builder(0, context.getString(R.string.phone_control_pairing_enter), reply)
            .addRemoteInput(input).setAllowGeneratedReplies(false).build()
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_runtime)
            .setContentTitle(context.getString(R.string.phone_control_pairing_title))
            .setContentText(problem ?: context.getString(R.string.phone_control_pairing_text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOnlyAlertOnce(problem == null)
            .addAction(action)
            .setTimeoutAfter(PAIRING_MS)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun notifications() = context.getSystemService(NotificationManager::class.java)

    class PairingReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val code = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_CODE)?.toString() ?: return
            (context.applicationContext as live.cohub.android.CohubApplication).display?.phone?.pair(code)
        }
    }

    private companion object {
        const val TAG = "CohubPhoneControl"
        const val PAIRED = "paired"
        const val PREPARED = "prepared"
        const val PORT = "port"
        const val PAIRING_PORT = "pairingPort"
        const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
        const val CONNECT_SERVICE = "_adb-tls-connect._tcp"
        const val PAIRING_SERVICE = "_adb-tls-pairing._tcp"
        const val CHANNEL_ID = "phone_control"
        const val NOTIFICATION_ID = 7
        const val KEY_CODE = "code"
        const val FIND_MS = 5_000L
        const val RESOLVE_MS = 3_000L
        const val ATTACH_MS = 8_000L
        const val RESTART_MS = 3_000L
        const val PAIRING_MS = 10 * 60_000L

        fun token(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(24).also(SecureRandom()::nextBytes))
    }
}
