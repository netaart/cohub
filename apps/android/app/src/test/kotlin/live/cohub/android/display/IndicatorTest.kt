package live.cohub.android.display

import live.cohub.android.display.Indicator.Mode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IndicatorTest {
    @Test
    fun `pick speaks for the most urgent screen, and inside Cohub for agents the page does not show`() {
        val sharing = "screen" to Indicator(Mode.SHARING)
        val working = "agent" to Indicator(Mode.WORKING)
        val held = "agent" to Indicator(Mode.HELD)
        assertEquals(working, Indicator.pick(listOf(sharing, working), inCohub = false))
        assertEquals(working, Indicator.pick(listOf(sharing, working), inCohub = true))
        assertNull(Indicator.pick(listOf(sharing, working), inCohub = true, shown = "agent"))
        assertEquals(held, Indicator.pick(listOf(held), inCohub = true, shown = "agent"))
        assertEquals(sharing, Indicator.pick(listOf(sharing, working), inCohub = true, pinned = "screen"))
    }
}
