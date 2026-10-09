package live.cohub.android.runtime

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

data class RuntimeInstance(
    val spaceId: String,
    val root: String,
    val label: String,
    val state: State,
    val error: String? = null,
) {
    enum class State(val wire: String) { STOPPED("stopped"), CONNECTING("connecting"), READY("ready"), ERROR("error") }

    fun toJson(): JsonObject = buildJsonObject {
        put("spaceId", spaceId)
        put("root", root)
        put("label", label)
        put("state", state.wire)
        put("error", error)
    }
}

fun List<RuntimeInstance>.toJson(): JsonObject = buildJsonObject {
    put("instances", buildJsonArray { forEach { add(it.toJson()) } })
}

data class FolderListing(
    val path: String,
    val label: String,
    val parent: String?,
    val spaceId: String?,
    val folders: List<File>,
    val volumes: List<Pair<File, String>>,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("path", path)
        put("label", label)
        put("parent", parent)
        put("spaceId", spaceId)
        put("folders", buildJsonArray {
            folders.forEach { add(buildJsonObject { put("name", it.name); put("path", it.path) }) }
        })
        put("volumes", buildJsonArray {
            volumes.forEach { (dir, label) -> add(buildJsonObject { put("path", dir.path); put("label", label) }) }
        })
    }
}

class FolderUnavailable(path: String) : Exception(path)

@Serializable
internal data class Binding(val account: String, val root: String, val spaceId: String, val enabled: Boolean)

internal fun List<Binding>.bind(owner: String, spaceId: String, root: String, running: Set<String>): Pair<List<Binding>, String?> {
    val folder = firstOrNull { it.account == owner && it.root == root }
    val space = firstOrNull { it.account == owner && it.spaceId == spaceId }
    if (folder != null && folder.spaceId in running && folder.spaceId != spaceId) return this to "folder_in_use"
    if (space != null && space.spaceId in running && space.root != root) return this to "space_in_use"
    return (this - setOfNotNull(folder, space) + Binding(owner, root, spaceId, enabled = true)) to null
}

class DeviceRuntime(private val context: Context, private val account: () -> String?) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val lock = Any()
    private var bindings: List<Binding> = load()
    private val live = mutableMapOf<String, Pair<RuntimeInstance.State, String?>>()
    private val snapshot = MutableStateFlow(instancesFor(account()))
    private val enabledBindings = MutableStateFlow(bindingsFor(account()).filter { it.enabled })

    val instances: StateFlow<List<RuntimeInstance>> = snapshot.asStateFlow()

    internal val enabled: StateFlow<List<Binding>> = enabledBindings.asStateFlow()

    val available: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && bridgeBinary.canExecute()

    val bridgeBinary: File
        get() = File(context.applicationInfo.nativeLibraryDir, "libcohub_sandboxd.so")

    fun hasStorageAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    suspend fun browse(path: String?): FolderListing = withContext(Dispatchers.IO) {
        val volumes = volumes()
        val dir = File(path ?: volumes.firstOrNull()?.first?.path ?: throw FolderUnavailable("")).canonicalFile
        val volume = volumes.firstOrNull { within(it.first, dir) } ?: throw FolderUnavailable(dir.path)
        if (!usable(dir, volume.first)) throw FolderUnavailable(dir.path)
        val folders = dir.listFiles { child -> child.isDirectory && usable(child, volume.first) }.orEmpty()
            .sortedBy { it.name.lowercase() }
            .take(MAX_FOLDERS)
        val spaceId = synchronized(lock) { bindingsFor(account()).firstOrNull { it.root == dir.path }?.spaceId }
        FolderListing(
            path = dir.path,
            label = label(dir, volumes),
            parent = dir.parentFile?.takeIf { dir != volume.first }?.path,
            spaceId = spaceId,
            folders = folders,
            volumes = volumes.map { it.first to it.second },
        )
    }

    suspend fun start(spaceId: String, root: String): String? = withContext(Dispatchers.IO) {
        val volumes = volumes()
        val dir = File(root).canonicalFile
        val volume = volumes.firstOrNull { within(it.first, dir) }
        if (volume == null || !usable(dir, volume.first)) return@withContext REFUSED_FOLDER_UNAVAILABLE
        val owner = account() ?: throw IllegalStateException("Signed out")
        synchronized(lock) {
            val running = live.filterValues { (state) -> state == RuntimeInstance.State.CONNECTING || state == RuntimeInstance.State.READY }.keys
            val (next, refused) = bindings.bind(owner, spaceId, dir.path, running)
            if (refused != null) return@withContext refused
            if (next != bindings) {
                bindings = next
                live.remove(spaceId)
                save()
            }
        }
        launchService()
        null
    }

    fun resume() {
        if (available && hasStorageAccess() && enabledBindings.value.isNotEmpty()) launchService()
    }

    fun accountChanged() {
        synchronized(lock) { recompute() }
    }

    fun stop(spaceId: String) {
        synchronized(lock) {
            bindings = bindings.map { if (it.spaceId == spaceId) it.copy(enabled = false) else it }
            live.remove(spaceId)
            save()
        }
    }

    fun stopAll() {
        synchronized(lock) {
            bindings = bindings.map { it.copy(enabled = false) }
            live.clear()
            save()
        }
    }

    internal fun publish(spaceId: String, state: RuntimeInstance.State) {
        synchronized(lock) {
            if (bindings.none { it.spaceId == spaceId && it.enabled }) return
            live[spaceId] = state to null
            refresh()
        }
    }

    internal fun fail(spaceId: String, code: String) {
        synchronized(lock) {
            bindings = bindings.map { if (it.spaceId == spaceId) it.copy(enabled = false) else it }
            live[spaceId] = RuntimeInstance.State.ERROR to code
            save()
        }
    }

    internal fun clearLive() {
        synchronized(lock) {
            live.entries.removeAll { it.value.first != RuntimeInstance.State.ERROR }
            refresh()
        }
    }

    internal fun label(dir: File, volumes: List<Pair<File, String>> = volumes()): String {
        val volume = volumes.firstOrNull { within(it.first, dir) } ?: return dir.path
        val relative = dir.relativeTo(volume.first).path
        return if (relative.isEmpty()) volume.second else "${volume.second}/$relative"
    }

    private fun launchService() {
        ContextCompat.startForegroundService(context, Intent(context, RuntimeService::class.java))
    }

    private fun bindingsFor(owner: String?): List<Binding> = if (owner == null) emptyList() else bindings.filter { it.account == owner }

    private fun instancesFor(owner: String?): List<RuntimeInstance> {
        val volumes = volumes()
        return bindingsFor(owner).map { binding ->
            val (state, error) = live[binding.spaceId] ?: (RuntimeInstance.State.STOPPED to null)
            RuntimeInstance(binding.spaceId, binding.root, label(File(binding.root), volumes), state, error)
        }
    }

    private fun refresh() {
        snapshot.value = instancesFor(account())
    }

    private fun recompute() {
        enabledBindings.value = bindingsFor(account()).filter { it.enabled }
        refresh()
    }

    private fun save() {
        prefs.edit { putString(KEY_BINDINGS, Json.encodeToString(ListSerializer(Binding.serializer()), bindings)) }
        recompute()
    }

    private fun load(): List<Binding> = prefs.getString(KEY_BINDINGS, null)
        ?.let { runCatching { Json.decodeFromString(ListSerializer(Binding.serializer()), it) }.getOrNull() }
        .orEmpty()

    private fun volumes(): List<Pair<File, String>> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        return context.getSystemService(StorageManager::class.java).storageVolumes
            .filter { it.state == Environment.MEDIA_MOUNTED }
            .mapNotNull { volume -> volume.directory?.let { it.canonicalFile to volume.getDescription(context) } }
    }

    private fun within(root: File, dir: File): Boolean = dir == root || dir.path.startsWith(root.path + File.separator)

    private fun usable(dir: File, volume: File): Boolean =
        dir.canRead() && PRIVATE.none { within(File(volume, it), dir) }

    private companion object {
        const val PREFS = "cohub-runtime"
        const val KEY_BINDINGS = "bindings"
        const val MAX_FOLDERS = 10_000
        const val REFUSED_FOLDER_UNAVAILABLE = "folder_unavailable"
        val PRIVATE = listOf("Android/data", "Android/obb")
    }
}
