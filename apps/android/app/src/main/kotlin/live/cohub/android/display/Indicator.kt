package live.cohub.android.display

internal data class Indicator(
    val mode: Mode,
    val label: String? = null,
    val steps: List<String> = emptyList(),
    val preview: ScreenSize? = null,
    val recording: Boolean = false,
) {
    enum class Mode { SHARING, WATCHING, RECORDING, WORKING, ASKING, HELD }

    val needsPerson: Boolean get() = mode == Mode.ASKING || mode == Mode.HELD

    companion object {
        fun of(agent: Boolean, size: ScreenSize, activity: Activity?, handover: HandoverAsk?, held: Boolean, recent: List<String>, pinned: Boolean = false, recording: Boolean = false): Indicator? {
            val mode = when {
                held -> Mode.HELD
                handover != null -> Mode.ASKING
                activity != null -> Mode.WORKING
                recording -> Mode.RECORDING
                !agent -> Mode.SHARING
                pinned -> Mode.WATCHING
                else -> return null
            }
            return Indicator(
                mode = mode,
                label = if (mode == Mode.WORKING) activity?.label else handover?.reason,
                steps = if (mode == Mode.WORKING || mode == Mode.ASKING) recent.dropLast(1) else emptyList(),
                preview = size.takeIf { agent && !held },
                recording = recording,
            )
        }

        /** Held stays: only the indicator hands back. */
        fun <T> pick(all: List<Pair<T, Indicator>>, inCohub: Boolean, shown: T? = null, pinned: T? = null): Pair<T, Indicator>? =
            all.filter { it.first == pinned || !inCohub || (it.second.mode != Mode.SHARING && (it.first != shown || it.second.mode == Mode.HELD)) }
                .minByOrNull { if (it.first == pinned) -1 else it.second.mode.rank }

        private val Mode.rank: Int get() = when (this) {
            Mode.HELD -> 0
            Mode.ASKING -> 1
            Mode.WORKING -> 2
            Mode.RECORDING -> 3
            Mode.WATCHING -> 4
            Mode.SHARING -> 5
        }
    }
}
