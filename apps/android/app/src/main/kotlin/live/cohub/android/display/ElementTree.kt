package live.cohub.android.display

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import androidx.annotation.RequiresApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

/**
 * The active window as the elements of the display protocol. Each read is a
 * snapshot whose refs (`e<snapshot>.<index>`) stay valid until a few newer
 * reads replace it. Acting on a ref re-checks that its node still shows the
 * same element: lists recycle views, so a scrolled row must not be clicked.
 */
@RequiresApi(Build.VERSION_CODES.R)
internal class ElementTree {
    private class Entry(val node: AccessibilityNodeInfo, val signature: String)
    private class Snapshot(val id: Int, val entries: List<Entry>)

    private val snapshots = ArrayDeque<Snapshot>()
    private var sequence = 0

    fun read(service: AccessibilityService, width: Int, height: Int, maxElements: Int): JsonObject {
        val root = service.rootInActiveWindow ?: throw DisplayError(DisplayError.UNAVAILABLE, "no window is showing")
        val id = synchronized(snapshots) { ++sequence }
        val nodes = mutableListOf<Entry>()
        val elements = mutableListOf<JsonObject>()
        var truncated = false
        val bounds = Rect()

        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (!node.isVisibleToUser) return
            val included = depth == 0 || node.isMeaningful()
            if (included) {
                if (elements.size == maxElements) {
                    truncated = true
                    return
                }
                nodes += Entry(node, node.signature())
                node.getBoundsInScreen(bounds)
                elements += node.toElement("e$id.${nodes.size}", depth, bounds, width, height)
            }
            for (index in 0 until node.childCount) {
                if (truncated) return
                node.getChild(index)?.let { visit(it, if (included) depth + 1 else depth) }
            }
        }

        visit(root, 0)
        synchronized(snapshots) {
            snapshots.addLast(Snapshot(id, nodes))
            while (snapshots.size > KEPT_SNAPSHOTS) snapshots.removeFirst()
        }
        return buildJsonObject {
            put("width", width)
            put("height", height)
            put("elements", JsonArray(elements))
            if (truncated) put("truncated", true)
        }
    }

    fun perform(service: ControlService, ref: String, action: String, text: String?) {
        val node = resolve(ref)
        val done = when (action) {
            "click" -> node.orAncestor { it.isClickable }?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: tap(service, node, TAP_MS)
            "longPress" -> node.orAncestor { it.isLongClickable }?.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK) ?: tap(service, node, LONG_PRESS_MS)
            "focus" -> node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            "setText" -> node.takeIf { it.isEditable }?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text.orEmpty())
            }) ?: throw DisplayError(DisplayError.UNSUPPORTED, "$ref is not a text field")
            "scrollForward", "scrollBackward" -> {
                val scroll = if (action == "scrollForward") AccessibilityAction.ACTION_SCROLL_FORWARD else AccessibilityAction.ACTION_SCROLL_BACKWARD
                node.orAncestor { it.isScrollable }?.performAction(scroll.id) ?: throw DisplayError(DisplayError.UNSUPPORTED, "$ref does not scroll")
            }
            else -> throw DisplayError(DisplayError.UNSUPPORTED, "element action $action is not supported")
        }
        if (!done) throw DisplayError(DisplayError.FAILED, "the app refused $action on $ref")
    }

    private fun resolve(ref: String): AccessibilityNodeInfo {
        val match = REF.matchEntire(ref) ?: throw DisplayError(DisplayError.INVALID, "$ref is not an element ref")
        val snapshot = synchronized(snapshots) { snapshots.find { it.id == match.groupValues[1].toInt() } }
            ?: throw DisplayError(DisplayError.INVALID, "$ref is from an old tree; read the tree again")
        val entry = snapshot.entries.getOrNull(match.groupValues[2].toInt() - 1)
            ?: throw DisplayError(DisplayError.INVALID, "$ref is not in its tree")
        val node = entry.node
        if (!node.refresh() || !node.isVisibleToUser || node.signature() != entry.signature) {
            throw DisplayError(DisplayError.INVALID, "$ref changed or left the screen; read the tree again")
        }
        return node
    }

    private fun AccessibilityNodeInfo.signature(): String {
        val bounds = Rect().also(::getBoundsInScreen)
        val item = collectionItemInfo?.let { "${it.rowIndex},${it.columnIndex}" }
        return listOf(className, viewIdResourceName, text, contentDescription, bounds.flattenToString(), item)
            .joinToString("\u0000") { it?.toString().orEmpty() }
    }

    private fun tap(service: ControlService, node: AccessibilityNodeInfo, durationMs: Long): Boolean {
        val bounds = Rect().also(node::getBoundsInScreen)
        if (bounds.isEmpty) return false
        val center = Point(bounds.exactCenterX(), bounds.exactCenterY())
        service.stroke(StrokePlan(listOf(center), durationMs), null, false) { _, _ -> }
        return true
    }

    private fun AccessibilityNodeInfo.orAncestor(matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = this
        repeat(ANCESTOR_DEPTH) {
            val node = current ?: return null
            if (matches(node)) return node
            current = node.parent
        }
        return null
    }

    private companion object {
        val REF = Regex("""e(\d{1,9})\.(\d{1,5})""")
        const val KEPT_SNAPSHOTS = 4
        const val ANCESTOR_DEPTH = 4
        const val TAP_MS = 60L
        const val LONG_PRESS_MS = 800L
        const val TEXT_MAX = 500
    }

    private fun AccessibilityNodeInfo.isMeaningful() =
        isClickable || isLongClickable || isEditable || isCheckable || isScrollable || isHeading ||
            !text.isNullOrBlank() || !contentDescription.isNullOrBlank()

    private fun AccessibilityNodeInfo.toElement(ref: String, depth: Int, bounds: Rect, width: Int, height: Int): JsonObject {
        val password = isPassword
        val label = contentDescription?.toString()?.takeIf { it.isNotBlank() }
        val shown = if (isShowingHintText) null else text?.toString()?.takeIf { it.isNotBlank() }
        val name = if (isEditable) label ?: hintText?.toString() else label ?: shown
        val value = if (isEditable && !password) shown else null
        val states = buildList {
            if (isFocused) add("focused")
            if (isSelected) add("selected")
            if (isChecked) add("checked")
            if (!isEnabled) add("disabled")
            if (isEditable) add("editable")
            if (password) add("password")
            if (isScrollable) add("scrollable")
        }
        val actions = buildList {
            if (isClickable) add("click")
            if (isLongClickable) add("longPress")
            if (isFocusable) add("focus")
            if (isEditable) add("setText")
            if (actionList.contains(AccessibilityAction.ACTION_SCROLL_FORWARD)) add("scrollForward")
            if (actionList.contains(AccessibilityAction.ACTION_SCROLL_BACKWARD)) add("scrollBackward")
        }
        fun unit(value: Int, extent: Int) = if (extent > 0) ((value.toFloat() / extent).coerceIn(0f, 1f) * 10_000).roundToInt() / 10_000.0 else 0.0
        return buildJsonObject {
            put("ref", ref)
            put("depth", depth)
            put("role", role(depth))
            name?.let { put("name", it.take(TEXT_MAX)) }
            value?.let { put("value", it.take(TEXT_MAX)) }
            put("bounds", JsonArray(listOf(
                unit(bounds.left, width), unit(bounds.top, height),
                unit(bounds.width(), width), unit(bounds.height(), height),
            ).map(::JsonPrimitive)))
            if (states.isNotEmpty()) put("states", JsonArray(states.map(::JsonPrimitive)))
            if (actions.isNotEmpty()) put("actions", JsonArray(actions.map(::JsonPrimitive)))
        }
    }

    private fun AccessibilityNodeInfo.role(depth: Int): String {
        val type = className?.toString()?.substringAfterLast('.').orEmpty()
        return when {
            depth == 0 -> "window"
            isHeading -> "heading"
            isEditable || type.endsWith("EditText") -> "textField"
            type.endsWith("Switch") || type == "ToggleButton" -> "switch"
            type.endsWith("CheckBox") -> "checkbox"
            type.endsWith("RadioButton") -> "radio"
            type.endsWith("SeekBar") -> "slider"
            type.endsWith("Button") -> "button"
            type == "WebView" -> "web"
            type.endsWith("ImageView") -> if (isClickable) "button" else "image"
            type.endsWith("RecyclerView") || type.endsWith("ListView") || type.endsWith("GridView") || type.endsWith("ScrollView") -> "list"
            type.endsWith("TabWidget") || type.endsWith("TabView") -> "tab"
            isCheckable -> "checkbox"
            isClickable -> "button"
            !text.isNullOrBlank() -> "text"
            else -> "group"
        }
    }
}
