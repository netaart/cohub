package live.cohub.android.display

internal data class Indicator(
    val mode: Mode,
    val label: String? = null,
    val steps: List<String> = emptyList(),
    val preview: ScreenSize? = null,
) {
    enum class Mode { SHARING, WORKING, ASKING, HELD }

    val needsPerson: Boolean get() = mode == Mode.ASKING || mode == Mode.HELD

    companion object {
        fun of(agent: Boolean, size: ScreenSize, activity: Activity?, handover: HandoverAsk?, held: Boolean, recent: List<String>): Indicator? {
            val mode = when {
                held -> Mode.HELD
                handover != null -> Mode.ASKING
                activity != null -> Mode.WORKING
                !agent -> Mode.SHARING
                else -> return null
            }
            return Indicator(
                mode = mode,
                label = if (mode == Mode.WORKING) activity?.label else handover?.reason,
                steps = if (mode == Mode.WORKING || mode == Mode.ASKING) recent.dropLast(1) else emptyList(),
                preview = size.takeIf { agent && !held },
            )
        }

        fun <T> pick(all: List<Pair<T, Indicator>>, inCohub: Boolean): Pair<T, Indicator>? =
            all.minByOrNull { it.second.mode.rank }?.takeIf { !inCohub || it.second.needsPerson }

        private val Mode.rank: Int get() = when (this) {
            Mode.HELD -> 0
            Mode.ASKING -> 1
            Mode.WORKING -> 2
            Mode.SHARING -> 3
        }
    }
}
