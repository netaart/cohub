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
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.update
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
import live.cohub.android.display.DisplayControl
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
    enum class Stage(val wire: String) { OFF("off"), DEVELOPER("developer"), PAIRING("pairing"), CODE("code"), STARTING("starting"), READY("ready"), STOPPED("stopped") }

    data class State(val stage: Stage, val error: String? = null, val codeInput: Boolean = false, val detail: String? = null) {
        val searching: Boolean get() = stage == Stage.DEVELOPER || stage == Stage.PAIRING
        val guiding: Boolean get() = searching || stage == Stage.CODE

        fun toJson(): JsonObject = buildJsonObject {
            put("stage", stage.wire)
            put("error", error)
            if (codeInput) put("codeInput", true)
            if (detail != null) put("detail", detail)
        }
    }

    private val keyFile = File(context.noBackupFilesDir, "helper/adb.key")
    private val prefs = context.getSharedPreferences("phone_control", Context.MODE_PRIVATE)
    private val cipher = CredentialCipher(KeystoreKey("live.cohub.android.adb"))
    private val starting = Mutex()
    private val pairingLock = Mutex()
    private val token = Binder()
    @Volatile private var nonce: String? = null
    private var pairing: Job? = null

    private val _helper = MutableStateFlow<ICohubHelper?>(null)
    val helper: StateFlow<ICohubHelper?> = _helper.asStateFlow()

    private val _state = MutableStateFlow(State(initialStage()))
    val state: StateFlow<State> = _state.asStateFlow()

    private val paired: Boolean get() = prefs.getBoolean(PAIRED, false) && keyFile.isFile

    @Volatile var multiWindow = false
        set(value) {
            field = value
            _state.update { it.copy(codeInput = it.stage == Stage.CODE && value) }
        }

    private fun enter(stage: Stage, error: String? = null): State =
        State(stage, error, stage == Stage.CODE && multiWindow, _state.value.detail.takeUnless { stage == Stage.READY }).also { _state.value = it }

    private fun note(detail: String) {
        Log.i(TAG, detail)
        _state.update { it.copy(detail = detail.take(DETAIL_MAX)) }
    }

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
                    note("the helper stopped")
                    enter(Stage.STOPPED, "helper_stopped")
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
        enter(Stage.READY)
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
        val listed = Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty().split(':').filter { it.isNotEmpty() }
        fun list(services: List<String>) = Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, services.joinToString(":"))
        when {
            service !in listed -> list(listed + service)
            DisplayControl.service.value == null -> {
                // The system leaves a service that crashed unbound until it leaves the list.
                list(listed - service)
                scope.launch {
                    delay(REBIND_MS)
                    list(listed)
                }
            }
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
                enter(Stage.STARTING)
                val error = launchHelper()
                if (error != null && _helper.value == null) {
                    enter(if (error == "unpaired") Stage.OFF else Stage.STOPPED, error)
                }
            }
        }
    }

    private suspend fun launchHelper(): String? {
        val key = key() ?: return "unpaired"
        if (canWriteSecureSettings()) runCatching { Settings.Global.putInt(context.contentResolver, ADB_WIFI_ENABLED, 1) }
        val next = token()
        nonce = next
        val info = context.applicationInfo
        val command = "CLASSPATH=${info.sourceDir} setsid app_process /system/bin --nice-name=${context.packageName}:helper " +
            "${HelperMain::class.java.name} ${context.packageName} ${info.uid} $next </dev/null >$HELPER_OUT 2>&1 &"
        val last = prefs.getInt(PORT, 0)
        val launched = System.currentTimeMillis()
        val ran = (last > 0 && exec(key, last, command)) || connectPort(last)?.let { exec(key, it, command) } == true
        if (!ran) return when {
            !paired -> "unpaired"
            !localNetwork -> LOCAL_NETWORK_OFF
            !onWifi() -> WIFI_OFF
            else -> "wireless_debugging_unreachable"
        }
        if (withTimeoutOrNull(ATTACH_MS) { _helper.first { it != null } } != null) return null
        note("the helper did not attach within ${ATTACH_MS / 1000} s: ${helperFailure(key, launched)}")
        return "helper_did_not_start"
    }

    /** The helper logs as the shell, which only adbd can read back. */
    private fun helperFailure(key: AdbKey, since: Long): String {
        val time = "%d.%03d".format(since / 1000, since % 1000)
        val log = runCatching { Adb.exec(key, prefs.getInt(PORT, 0), "cat $HELPER_OUT; logcat -d -b main,crash -v brief -t $time -s ${Helper.TAG}:I AndroidRuntime:E") }
            .getOrElse { return "its log could not be read (${it.message})" }
        val lines = log.lines().map { it.substringAfter("): ").trim() }.filter { it.isNotEmpty() && !it.startsWith("at ") && !it.startsWith("-----") }
        return lines.lastOrNull { it.startsWith("Caused by:") } ?: lines.firstOrNull { "Exception" in it || "Error" in it }
            ?: lines.lastOrNull()?.let { "it stopped after \"$it\"" } ?: "it logged nothing"
    }

    private suspend fun connectPort(last: Int): Int? {
        val port = findPort(CONNECT_SERVICE, FIND_MS)
        if (port == null) note("Wireless debugging is not advertised on this phone")
        return port?.takeIf { it != last }
    }

    private fun exec(key: AdbKey, port: Int, command: String): Boolean = try {
        Adb.exec(key, port, command)
        prefs.edit { putInt(PORT, port) }
        true
    } catch (error: Adb.Unauthorized) {
        note("adbd on port $port refused the key")
        prefs.edit { putBoolean(PAIRED, false) }
        false
    } catch (error: Exception) {
        note("adbd is not on port $port: ${error.message}")
        false
    }

    private val developerOptions: Boolean
        get() = global(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED) || global(ADB_WIFI_ENABLED)

    private fun global(name: String) = runCatching { Settings.Global.getInt(context.contentResolver, name, 0) == 1 }.getOrDefault(false)

    fun setup(): State {
        val current = _state.value
        if (current.stage == Stage.READY || current.stage == Stage.STARTING) return current
        if (!localNetwork) return enter(if (paired) Stage.STOPPED else Stage.OFF, LOCAL_NETWORK_OFF)
        if (paired) {
            start()
            return current
        }
        if (!notificationsAllowed()) return enter(Stage.OFF, "notifications_off")
        return awaitPairing(null)
    }

    fun settingsIntent(): Intent {
        val developer = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
        val intent = if (developer.resolveActivity(context.packageManager) != null) developer else Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)
        return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    @Synchronized
    private fun awaitPairing(error: String?): State {
        pairing?.cancel()
        val state = enter(if (developerOptions) Stage.PAIRING else Stage.DEVELOPER, error)
        pairing = scope.launch(Dispatchers.IO) {
            val settled = withTimeoutOrNull(PAIRING_MS) {
                awaitPairingDialog(error)
                _state.first { it.stage != Stage.CODE }
            }
            if (settled == null) enter(Stage.OFF, "pairing_timed_out")
        }
        return state
    }

    @Synchronized
    private fun stopPairing() {
        pairing?.cancel()
    }

    // The dialog being advertised is the truth; settings flags only shape the hint, as some phones misreport them.
    private suspend fun awaitPairingDialog(error: String?) {
        var shown: Int? = null
        while (_state.value.searching) {
            val stage = if (developerOptions) Stage.PAIRING else Stage.DEVELOPER
            enter(stage, if (!localNetwork) LOCAL_NETWORK_OFF else if (stage == Stage.PAIRING && !onWifi()) WIFI_OFF else error)
            val text = when {
                error != null -> R.string.phone_control_pairing_closed
                stage == Stage.DEVELOPER -> R.string.phone_control_guide_developer
                else -> R.string.phone_control_guide_pairing
            }
            if (text != shown) {
                notifyPairing(context.getString(text))
                shown = text
            }
            val port = findPort(PAIRING_SERVICE, FIND_MS)
            if (port == null) {
                delay(RETRY_MS)
                continue
            }
            if (!_state.value.searching) break
            prefs.edit { putInt(PAIRING_PORT, port) }
            enter(Stage.CODE)
            notifyPairing(context.getString(R.string.phone_control_pairing_text))
        }
    }

    fun pair(code: String): Deferred<State> = scope.async(Dispatchers.IO) {
        pairingLock.withLock {
            if (!_state.value.guiding) return@withLock _state.value
            val key = key(create = true) ?: return@withLock _state.value
            val digits = code.filter(Char::isDigit)
            val last = prefs.getInt(PAIRING_PORT, 0).takeIf { _state.value.stage == Stage.CODE }
            var result = last?.let { pairOnce(key, it, digits) }
            val port = if (result == true) last else findPort(PAIRING_SERVICE, FIND_MS)
            if (port != null && port != last) {
                prefs.edit { putInt(PAIRING_PORT, port) }
                if (result == null) result = pairOnce(key, port, digits)
            }
            when {
                result == true -> {
                    prefs.edit { putBoolean(PAIRED, true).putBoolean(PREPARED, false) }
                    stopPairing()
                    notifications().cancel(NOTIFICATION_ID)
                    enter(Stage.STARTING).also {
                        start()
                        watchWifi()
                    }
                }
                result == false && port != null -> {
                    notifyPairing(context.getString(R.string.phone_control_pairing_wrong), alert = true)
                    enter(Stage.CODE, "pairing_wrong")
                }
                else -> awaitPairing("pairing_closed")
            }
        }
    }

    /** true paired, false the code was refused, null nothing paired on that port. */
    private fun pairOnce(key: AdbKey, port: Int, code: String): Boolean? = try {
        AdbPairing.pair(key, port, code)
        true
    } catch (_: AdbPairing.WrongCode) {
        false
    } catch (error: Exception) {
        note("no pairing on port $port: ${error.message}")
        null
    }

    private fun notificationsAllowed() =
        NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            notifications().getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE

    @Suppress("DEPRECATION")
    private fun onWifi(): Boolean {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        return connectivity.allNetworks.any { connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
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

    // Without the permission Android 17 answers every discovery with a device picker.
    private val localNetwork: Boolean
        get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.CINNAMON_BUN ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED

    private suspend fun findPort(type: String, timeoutMs: Long): Int? {
        if (!localNetwork) return null
        val nsd = context.getSystemService(NsdManager::class.java)
        return withTimeoutOrNull(timeoutMs) {
            callbackFlow {
                val listener = object : NsdManager.DiscoveryListener {
                    override fun onServiceFound(service: NsdServiceInfo) {
                        trySend(service)
                    }
                    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                        note("discovering $serviceType failed: $errorCode")
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

    private fun channel(): String {
        notifications().createNotificationChannel(NotificationChannel(CHANNEL_ID, context.getString(R.string.phone_control_channel), NotificationManager.IMPORTANCE_HIGH))
        return CHANNEL_ID
    }

    private fun settingsPendingIntent() = PendingIntent.getActivity(
        context, 0, settingsIntent(),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    fun notifyHandover(reason: String) {
        val take = PendingIntent.getBroadcast(context, 0, Intent(context, HandoverReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val text = context.getString(R.string.overlay_activity, reason)
        val notification = NotificationCompat.Builder(context, channel())
            .setSmallIcon(R.drawable.ic_runtime)
            .setContentTitle(context.getString(R.string.overlay_needs_you))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(take)
            .setAutoCancel(true)
            .addAction(0, context.getString(R.string.overlay_take_over), take)
            .build()
        runCatching { notifications().notify(HANDOVER_NOTIFICATION_ID, notification) }
    }

    fun cancelHandover() = notifications().cancel(HANDOVER_NOTIFICATION_ID)

    private fun notifyPairing(text: String, alert: Boolean = false) {
        val manager = notifications()
        val reply = PendingIntent.getBroadcast(
            context, 0, Intent(context, PairingReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val input = RemoteInput.Builder(KEY_CODE).setLabel(context.getString(R.string.phone_control_pairing_code)).build()
        val action = NotificationCompat.Action.Builder(0, context.getString(R.string.phone_control_pairing_enter), reply)
            .addRemoteInput(input).setAllowGeneratedReplies(false).build()
        val notification = NotificationCompat.Builder(context, channel())
            .setSmallIcon(R.drawable.ic_runtime)
            .setContentTitle(context.getString(R.string.phone_control_pairing_title))
            .setContentIntent(settingsPendingIntent())
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOnlyAlertOnce(!alert)
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

    class HandoverReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            (context.applicationContext as live.cohub.android.CohubApplication).display?.takeOverAsked()
        }
    }

    private companion object {
        const val TAG = "CohubPhoneControl"
        const val PAIRED = "paired"
        const val PREPARED = "prepared"
        const val REBIND_MS = 500L
        const val HELPER_OUT = "/data/local/tmp/cohub-helper.out"
        const val PORT = "port"
        const val PAIRING_PORT = "pairingPort"
        const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
        const val LOCAL_NETWORK_OFF = "local_network_off"
        const val WIFI_OFF = "wifi_off"
        const val DETAIL_MAX = 240
        const val CONNECT_SERVICE = "_adb-tls-connect._tcp"
        const val PAIRING_SERVICE = "_adb-tls-pairing._tcp"
        const val CHANNEL_ID = "phone_control"
        const val NOTIFICATION_ID = 7
        const val HANDOVER_NOTIFICATION_ID = 8
        const val RETRY_MS = 1_000L
        const val KEY_CODE = "code"
        const val FIND_MS = 5_000L
        const val RESOLVE_MS = 3_000L
        const val ATTACH_MS = 8_000L
        const val RESTART_MS = 3_000L
        const val PAIRING_MS = 10 * 60_000L

        fun token(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(24).also(SecureRandom()::nextBytes))
    }
}
