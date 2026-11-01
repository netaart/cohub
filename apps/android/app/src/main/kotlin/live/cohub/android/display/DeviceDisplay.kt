package live.cohub.android.display

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import live.cohub.android.helper.Helper
import live.cohub.android.helper.ICohubHelper
import live.cohub.android.helper.PhoneControl
import kotlin.math.roundToInt

data class DisplayStatus(val sharedWith: String?, val control: Boolean, val phoneControl: PhoneControl.State, val error: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("sharedWith", sharedWith)
        put("control", control)
        put("error", error)
        put("phoneControl", phoneControl.toJson())
    }
}

data class Activity(val sessionId: String?, val turnId: String?, val label: String?)

data class HandoverAsk(val reason: String, val sessionId: String?, val turnId: String?)

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class Served(val spaceId: String, val screen: Screen, val elements: ElementTree, val input: InputDriver) {
    val inputs = Mutex()
    @Volatile var activity: Activity? = null
    @Volatile var handover: HandoverAsk? = null
    @Volatile var recent: List<String> = emptyList()
    @Volatile var held = false
    @Volatile var watched = false
    @Volatile var usedAt = SystemClock.elapsedRealtime()
    @Volatile var takenTask = -1
}

internal class DisplayEvent(val spaceId: String, val message: JsonObject)

@SuppressLint("NewApi")
class DeviceDisplay(private val context: Context, private val scope: CoroutineScope, val phone: PhoneControl, private val stopTurn: suspend (Activity) -> Unit) {
    private val shared = MutableStateFlow<Served?>(null)
    private val agents = MutableStateFlow<Map<String, Served>>(emptyMap())
    private val failure = MutableStateFlow<String?>(null)
    private val displays = context.getSystemService(DisplayManager::class.java)
    private val events = MutableSharedFlow<DisplayEvent>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val revision = MutableStateFlow(0)

    internal val messages: SharedFlow<DisplayEvent> = events.asSharedFlow()

    val status: StateFlow<DisplayStatus> = combine(shared, DisplayControl.service, phone.state, failure) { current, control, phoneControl, error ->
        DisplayStatus(current?.spaceId, control != null, phoneControl, error)
    }.stateIn(scope, SharingStarted.Eagerly, DisplayStatus(null, DisplayControl.service.value != null, phone.state.value))

    internal val changes: StateFlow<Any> = combine(shared, agents, phone.helper, DisplayControl.service, revision) { a, b, c, d, e -> listOf(a, b, c, d, e) }
        .stateIn(scope, SharingStarted.Eagerly, Unit)

    internal fun served(): List<Served> = listOfNotNull(shared.value) + agents.value.values

    init {
        scope.launch { phone.helper.collect { helper -> if (helper == null) releaseAll() } }
        scope.launch {
            DisplayControl.windows.collect { displayId ->
                servedOn(displayId)?.takeIf { it.watched }?.let(::changed)
                if (displayId == Display.DEFAULT_DISPLAY && agents.value.isNotEmpty()) phone.helper.value?.runCatching { syncAudio() }
            }
        }
        displays.registerDisplayListener(object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
            override fun onDisplayChanged(displayId: Int) {
                servedOn(displayId)?.screen?.resize(sizeOf(displayId) ?: return)
                bump()
            }
        }, Handler(Looper.getMainLooper()))
        scope.launch {
            while (isActive) {
                delay(IDLE_CHECK_MS)
                val idle = SystemClock.elapsedRealtime() - IDLE_MS
                agents.value.values.filter { it.usedAt < idle && it.activity == null && it.handover == null && !it.held && !it.screen.streaming }.forEach { stopAgent(it.spaceId) }
            }
        }
    }

    private fun servedOn(displayId: Int): Served? = served().firstOrNull { it.screen.displayId == displayId }

    private fun changed(served: Served) {
        events.tryEmit(DisplayEvent(served.spaceId, DisplayWire.changed(served.screen.id)))
    }

    private fun bump() = revision.update { it + 1 }

    private fun requireHelper(): ICohubHelper =
        phone.helper.value ?: throw DisplayError(DisplayError.UNAVAILABLE, "phone control is off; set it up in the Cohub app")

    private fun open(spaceId: String, id: String, displayId: Int?, size: ScreenSize): Served {
        val helper = requireHelper()
        lateinit var served: Served
        val frames = FrameChanges(size) { changed(served) }
        val displayIdOrNew = try {
            displayId ?: helper.createDisplay("Cohub", size.width, size.height, size.densityDpi, frames.surface)
        } catch (error: Exception) {
            frames.close()
            throw DisplayError(DisplayError.FAILED, error.message ?: "the phone could not start a screen for agents")
        }
        val screen = Screen(id, displayIdOrNew, size, helper, frames)
        val elements = ElementTree()
        served = Served(spaceId, screen, elements, InputDriver(helper, screen, elements) { DisplayControl.service.value })
        return served
    }

    fun share(spaceId: String): DisplayStatus {
        failure.value = null
        stop()
        try {
            shared.value = open(spaceId, SCREEN_ID, Display.DEFAULT_DISPLAY, phoneSize())
        } catch (error: DisplayError) {
            failure.value = if (phone.helper.value == null) "phone_control_off" else "failed"
        }
        return status.value
    }

    fun stop() {
        shared.getAndUpdate { null }?.screen?.release()
    }

    @Synchronized
    internal fun startAgent(spaceId: String) {
        if (agents.value.containsKey(spaceId)) return
        val served = open(spaceId, AGENT_ID, null, phoneSize())
        agents.update { it + (spaceId to served) }
    }

    internal fun disconnected(spaceId: String) {
        served().filter { it.spaceId == spaceId }.forEach { served ->
            served.watched = false
            served.screen.watch(false)
            served.activity = null
            setHandover(served, null)
        }
        bump()
    }

    internal fun stopAgent(spaceId: String) {
        val served = agents.value[spaceId] ?: return
        agents.update { it - spaceId }
        served.screen.release()
    }

    private fun releaseAll() {
        stop()
        agents.getAndUpdate { emptyMap() }.values.forEach { it.screen.release() }
    }

    internal fun displays(spaceId: String): List<DisplayInfo> {
        if (phone.helper.value == null) return emptyList()
        val control = DisplayControl.service.value != null
        val needs = if (control) emptyList() else listOf("accessibility")
        return listOfNotNull(shared.value?.takeIf { it.spaceId == spaceId }, agents.value[spaceId]).map { served ->
            val size = served.screen.size
            val agent = served.screen.agent
            DisplayInfo(
                id = served.screen.id,
                name = android.os.Build.MODEL ?: "Android",
                width = size.width, height = size.height, stream = true, capture = true, input = true,
                system = InputDriver.systemButtons(agent), platform = "android", tree = control, focus = control, needs = needs,
                kind = if (agent) "agent" else "screen", apps = agent, changes = true,
            )
        }
    }

    internal fun virtual(spaceId: String): String? = when {
        phone.helper.value == null -> null
        agents.value.containsKey(spaceId) -> "running"
        else -> "available"
    }

    internal fun served(spaceId: String, id: String): Served {
        val served = when (id) {
            SCREEN_ID -> shared.value?.takeIf { it.spaceId == spaceId }
            AGENT_ID -> agents.value[spaceId]
            else -> null
        } ?: throw DisplayError(DisplayError.NOT_FOUND, "display $id not found")
        served.usedAt = SystemClock.elapsedRealtime()
        return served
    }

    internal suspend fun input(spaceId: String, id: String, events: List<InputEvent>, startBy: Long) {
        val served = served(spaceId, id)
        served.inputs.withLock {
            if (startBy > 0 && System.currentTimeMillis() > startBy) throw DisplayError(DisplayError.TIMEOUT, "the input waited too long to start")
            withContext(Dispatchers.Default) { served.input.apply(events) }
        }
    }

    internal suspend fun tree(spaceId: String, id: String, maxElements: Int): JsonObject {
        val served = served(spaceId, id)
        val service = DisplayControl.service.value
            ?: throw DisplayError(DisplayError.UNAVAILABLE, "control is off; enable Cohub in Accessibility settings")
        val size = served.screen.size
        return withContext(Dispatchers.Default) { served.elements.read(service, served.screen.displayId, size.width, size.height, maxElements) }
    }

    internal fun focus(spaceId: String) = DisplayControl.focus.map { all ->
        listOfNotNull(shared.value?.takeIf { it.spaceId == spaceId }, agents.value[spaceId]).associate { served ->
            val size = served.screen.size
            served.screen.id to all[served.screen.displayId]?.let { focused ->
                fun unit(value: Int, extent: Int) = ((value.toFloat() / extent.coerceAtLeast(1)).coerceIn(0f, 1f) * 10_000).roundToInt() / 10_000.0
                val bounds = focused.bounds
                buildJsonObject {
                    put("bounds", JsonArray(listOf(unit(bounds.left, size.width), unit(bounds.top, size.height), unit(bounds.width(), size.width), unit(bounds.height(), size.height)).map(::JsonPrimitive)))
                    if (focused.password) put("password", true)
                }
            }
        }
    }.distinctUntilChanged()

    internal fun launch(spaceId: String, id: String, app: String?, url: String?) {
        val served = served(spaceId, id)
        if (!served.screen.agent) throw DisplayError(DisplayError.UNSUPPORTED, "apps launch on the agent's screen")
        val intent = if (app != null) {
            context.packageManager.getLaunchIntentForPackage(app) ?: throw DisplayError(DisplayError.NOT_FOUND, "$app is not installed")
        } else {
            android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
        }
        when (requireHelper().start(served.screen.displayId, intent)) {
            Helper.START_OK -> Unit
            Helper.START_IN_USE -> throw DisplayError(DisplayError.BUSY, "the person is using ${app ?: "that app"} on the phone; ask them, or wait")
            Helper.START_NOT_FOUND -> throw DisplayError(DisplayError.NOT_FOUND, "nothing on the phone opens ${app ?: url}")
            else -> throw DisplayError(DisplayError.FAILED, "the phone could not open ${app ?: url}")
        }
    }

    internal fun apps(): JsonObject {
        val manager = context.packageManager
        val launcher = android.content.Intent(android.content.Intent.ACTION_MAIN).addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        val apps = manager.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.packageName to it.loadLabel(manager).toString() }
            .distinctBy { it.first }
            .filter { it.first != context.packageName }
            .sortedBy { it.second.lowercase() }
            .take(DisplayVocabulary.MAX_APPS)
        return buildJsonObject {
            put("apps", buildJsonArray { apps.forEach { (id, name) -> add(buildJsonObject { put("id", id); put("name", name) }) } })
        }
    }

    internal fun watch(spaceId: String, id: String, on: Boolean) {
        val served = runCatching { served(spaceId, id) }.getOrNull() ?: return
        served.watched = on
        served.screen.watch(on)
    }

    internal fun activity(spaceId: String, id: String, activity: Activity?) {
        val served = runCatching { served(spaceId, id) }.getOrNull() ?: return
        served.activity = activity
        served.recent = when {
            activity == null -> emptyList()
            activity.label == null || activity.label == served.recent.lastOrNull() -> served.recent
            else -> (served.recent + activity.label).takeLast(RECENT_STEPS)
        }
        bump()
    }

    internal fun handover(spaceId: String, id: String, ask: HandoverAsk?) {
        setHandover(runCatching { served(spaceId, id) }.getOrNull() ?: return, ask)
        bump()
    }

    private fun setHandover(served: Served, ask: HandoverAsk?) {
        served.handover = ask
        if (ask != null) phone.notifyHandover(ask.reason) else if (served().none { it.handover != null }) phone.cancelHandover()
    }

    internal fun takeOverAsked() {
        served().firstOrNull { it.handover != null && !it.held }?.let(::takeOver)
    }

    internal fun takeOver(served: Served) {
        phone.cancelHandover()
        served.held = true
        events.tryEmit(DisplayEvent(served.spaceId, DisplayWire.hold(served.screen.id, true)))
        if (served.screen.agent) served.takenTask = phone.helper.value?.runCatching { moveTop(served.screen.displayId, Display.DEFAULT_DISPLAY) }?.getOrNull() ?: -1
        bump()
    }

    internal fun handBack(served: Served) {
        if (served.takenTask >= 0) phone.helper.value?.runCatching { moveTask(served.takenTask, served.screen.displayId) }
        served.takenTask = -1
        served.held = false
        setHandover(served, null)
        events.tryEmit(DisplayEvent(served.spaceId, DisplayWire.hold(served.screen.id, false)))
        bump()
    }

    internal fun interrupt(served: Served) {
        events.tryEmit(DisplayEvent(served.spaceId, DisplayWire.interrupt(served.screen.id)))
        val activity = served.activity ?: served.handover?.let { Activity(it.sessionId, it.turnId, null) }
        served.activity = null
        setHandover(served, null)
        bump()
        if (activity?.sessionId != null) scope.launch { runCatching { stopTurn(activity) }.onFailure { Log.w(TAG, "The Turn could not be stopped", it) } }
    }

    fun provide(scope: CoroutineScope, spaceId: String, socket: java.io.File) = scope.launch {
        phone.start()
        try {
            DisplayProvider(spaceId, socket, this@DeviceDisplay).serve()
        } catch (error: java.io.IOException) {
            Log.w(TAG, "Display provider unavailable for $spaceId", error)
        } finally {
            stopAgent(spaceId)
        }
    }

    private fun phoneSize(): ScreenSize = sizeOf(Display.DEFAULT_DISPLAY) ?: throw DisplayError(DisplayError.UNAVAILABLE, "the phone has no screen")

    @Suppress("DEPRECATION")
    private fun sizeOf(displayId: Int): ScreenSize? {
        val point = android.graphics.Point()
        displays.getDisplay(displayId)?.getRealSize(point) ?: return null
        return ScreenSize(point.x, point.y, context.resources.displayMetrics.densityDpi)
    }

    companion object {
        const val SCREEN_ID = "screen"
        const val AGENT_ID = "agent"
        private const val IDLE_MS = 10 * 60_000L
        private const val IDLE_CHECK_MS = 60_000L
        private const val RECENT_STEPS = 3
        private const val TAG = "CohubDisplay"
    }
}
