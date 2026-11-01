package live.cohub.android.helper

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Parcel
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.InputEvent
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import androidx.annotation.RequiresApi
import java.util.concurrent.ConcurrentHashMap

@SuppressLint("PrivateApi", "DiscouragedPrivateApi", "BlockedPrivateApi", "SoonBlockedPrivateApi", "WrongConstant")
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class Helper(private val appUid: Int, private val appPackage: String) : ICohubHelper.Stub() {
    private val context: Context = ShellContext.create()
    private val displayManager = DisplayManager::class.java.getDeclaredConstructor(Context::class.java)
        .apply { isAccessible = true }.newInstance(context)
    private val displays = ConcurrentHashMap<Int, VirtualDisplay>()
    private val mirrors = ConcurrentHashMap<IBinder, VirtualDisplay>()
    private val muted = ConcurrentHashMap<String, String>()

    private val tasks: Any by lazy { Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null)!! }
    private val input: Any by lazy { Class.forName("android.hardware.input.InputManagerGlobal").getMethod("getInstance").invoke(null)!! }
    private val setDisplayId by lazy { InputEvent::class.java.getMethod("setDisplayId", Int::class.javaPrimitiveType) }
    private val inject by lazy { input.javaClass.getMethod("injectInputEvent", InputEvent::class.java, Int::class.javaPrimitiveType) }
    private val taskInfo by lazy { Class.forName("android.app.TaskInfo") }

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code != INTERFACE_TRANSACTION && Binder.getCallingUid() != appUid) throw SecurityException("the helper answers Cohub alone")
        return super.onTransact(code, data, reply, flags)
    }

    override fun createDisplay(name: String, width: Int, height: Int, densityDpi: Int, surface: Surface): Int = attempt(-1) {
        val display = displayManager.createVirtualDisplay(name, width, height, densityDpi, surface, AGENT_FLAGS)
        val id = display.display.displayId
        displays[id] = display
        runCatching {
            val wm = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null)!!
            wm.javaClass.getMethod("setDisplayImePolicy", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType).invoke(wm, id, IME_POLICY_LOCAL)
        }
        id
    }

    override fun releaseDisplay(displayId: Int) {
        displays.remove(displayId)?.release()
        unmuteGone()
    }

    override fun mirror(displayId: Int, width: Int, height: Int, surface: Surface): IBinder? = attempt(null) {
        val create = DisplayManager::class.java.getMethod(
            "createVirtualDisplay", String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Surface::class.java,
        )
        val owner = if (java.lang.reflect.Modifier.isStatic(create.modifiers)) null else displayManager
        val mirror = create.invoke(owner, "cohub-mirror", width, height, displayId, surface) as VirtualDisplay
        Binder().also { mirrors[it] = mirror }
    }

    override fun releaseMirror(token: IBinder) {
        mirrors.remove(token)?.release()
    }

    override fun touch(displayId: Int, action: Int, x: Float, y: Float, downTime: Long): Boolean = attempt(false) {
        val properties = arrayOf(MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER })
        val coords = arrayOf(MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f })
        val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 1, properties, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        try {
            send(event, displayId)
        } finally {
            event.recycle()
        }
    }

    override fun key(displayId: Int, action: Int, keyCode: Int, metaState: Int): Boolean = attempt(false) {
        val now = SystemClock.uptimeMillis()
        send(KeyEvent(now, now, action, keyCode, 0, metaState, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD), displayId)
    }

    private fun send(event: InputEvent, displayId: Int): Boolean {
        setDisplayId.invoke(event, displayId)
        return inject.invoke(input, event, INJECT_ASYNC) as Boolean
    }

    override fun start(displayId: Int, intent: Intent): Int = attempt(START_FAILED) {
        val target = intent.component?.packageName ?: intent.`package`
        if (displayId != Display.DEFAULT_DISPLAY && target != null && inUseOnPhone(target)) return@attempt START_IN_USE
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val options = ActivityOptions.makeBasic().setLaunchDisplayId(displayId).toBundle()
        val start = tasks.javaClass.methods.first { it.name == "startActivityAsUser" && it.parameterTypes.size == 12 }
        val result = start.invoke(tasks, null, ShellContext.PACKAGE, null, intent, null, null, null, 0, 0, null, options, USER_CURRENT) as Int
        when {
            result == START_INTENT_NOT_RESOLVED || result == START_CLASS_NOT_FOUND -> START_NOT_FOUND
            result < 0 -> START_FAILED
            else -> {
                if (displayId != Display.DEFAULT_DISPLAY) (target ?: topPackage(displayId))?.let(::mute)
                START_OK
            }
        }
    }

    override fun topPackage(displayId: Int): String? = attempt(null) { tasksOn(displayId).firstOrNull()?.let(::packageOf) }

    override fun moveTop(fromDisplayId: Int, toDisplayId: Int): Int = attempt(-1) {
        val task = tasksOn(fromDisplayId).firstOrNull() ?: return@attempt -1
        val id = taskInfo.getField("taskId").getInt(task)
        if (moveTask(id, toDisplayId)) id else -1
    }

    override fun moveTask(taskId: Int, displayId: Int): Boolean = attempt(false) {
        if (displayId != Display.DEFAULT_DISPLAY && !displays.containsKey(displayId)) return@attempt false
        tasks.javaClass.getMethod("moveRootTaskToDisplay", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType).invoke(tasks, taskId, displayId)
        val name = allTasks().firstOrNull { taskInfo.getField("taskId").getInt(it) == taskId }?.let(::packageOf)
        if (name != null) if (displayId == Display.DEFAULT_DISPLAY) unmute(name) else mute(name)
        true
    }

    override fun prepare() {
        sh("pm", "grant", appPackage, "android.permission.WRITE_SECURE_SETTINGS")
        sh("cmd", "deviceidle", "whitelist", "+$appPackage")
        sh("appops", "set", appPackage, "RUN_ANY_IN_BACKGROUND", "allow")
    }

    fun releaseAll() {
        mirrors.values.forEach { runCatching { it.release() } }
        mirrors.clear()
        displays.values.forEach { runCatching { it.release() } }
        displays.clear()
        muted.keys.toList().forEach(::unmute)
    }

    private fun allTasks(displayId: Int = Display.INVALID_DISPLAY): List<Any> {
        val get = tasks.javaClass.methods.first { it.name == "getTasks" && it.parameterTypes.size == 4 }
        return (get.invoke(tasks, MAX_TASKS, false, false, displayId) as List<*>).filterNotNull()
    }

    private fun tasksOn(displayId: Int): List<Any> {
        val field = taskInfo.getField("displayId")
        return allTasks(displayId).filter { field.getInt(it) == displayId }
    }

    private fun packageOf(task: Any): String? =
        listOf("topActivity", "baseActivity").firstNotNullOfOrNull { (taskInfo.getField(it).get(task) as? ComponentName)?.packageName }

    private fun inUseOnPhone(target: String): Boolean {
        val visible = taskInfo.getField("isVisible")
        return tasksOn(Display.DEFAULT_DISPLAY).any { packageOf(it) == target && visible.getBoolean(it) }
    }

    private fun mute(target: String) {
        if (target == appPackage || muted.containsKey(target)) return
        val mode = sh("appops", "get", target, "PLAY_AUDIO").substringAfter("PLAY_AUDIO:", "").trim().substringBefore(';').ifEmpty { "allow" }
        muted[target] = if (mode == "default") "allow" else mode
        sh("appops", "set", target, "PLAY_AUDIO", "ignore")
    }

    private fun unmute(target: String) {
        val mode = muted.remove(target) ?: return
        sh("appops", "set", target, "PLAY_AUDIO", mode)
    }

    private fun unmuteGone() {
        val still = displays.keys.flatMap { id -> tasksOn(id).mapNotNull(::packageOf) }.toSet()
        muted.keys.filter { it !in still }.forEach(::unmute)
    }

    private fun sh(vararg command: String): String = runCatching {
        val process = ProcessBuilder(*command).redirectErrorStream(true).start()
        process.inputStream.bufferedReader().readText().also { process.waitFor() }
    }.onFailure { Log.w(TAG, "${command.first()} failed", it) }.getOrDefault("")

    private inline fun <T> attempt(fallback: T, block: () -> T): T = try {
        block()
    } catch (error: Throwable) {
        Log.w(TAG, "helper call failed", error)
        fallback
    }

    companion object {
        const val TAG = "CohubHelper"
        const val START_OK = 0
        const val START_IN_USE = 1
        const val START_NOT_FOUND = 2
        const val START_FAILED = 3

        private const val USER_CURRENT = -2
        private const val START_INTENT_NOT_RESOLVED = -91
        private const val START_CLASS_NOT_FOUND = -92
        private const val INJECT_ASYNC = 0
        private const val MAX_TASKS = 50
        private const val IME_POLICY_LOCAL = 0

        // DisplayManager.VIRTUAL_DISPLAY_FLAG_*: public, own content only, touch,
        // rotates with content, destroys its apps when removed, no touch feedback,
        // trusted, its own display group, always unlocked, its own focus that
        // never takes the phone's.
        private const val AGENT_FLAGS = (1 shl 0) or (1 shl 3) or (1 shl 6) or (1 shl 7) or (1 shl 8) or
            (1 shl 13) or (1 shl 10) or (1 shl 11) or (1 shl 12) or (1 shl 14) or (1 shl 16)
    }
}
