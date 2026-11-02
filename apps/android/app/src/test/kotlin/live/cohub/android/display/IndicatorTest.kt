package live.cohub.android.display

import live.cohub.android.display.Indicator.Mode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IndicatorTest {
    @Test
    fun `pick speaks for the most urgent screen and steps aside inside Cohub`() {
        val sharing = "screen" to Indicator(Mode.SHARING)
        val working = "agent" to Indicator(Mode.WORKING)
        val asking = "agent" to Indicator(Mode.ASKING, "Pay")
        assertEquals(working, Indicator.pick(listOf(sharing, working), inCohub = false))
        assertEquals(asking, Indicator.pick(listOf(sharing, asking), inCohub = true))
        assertNull(Indicator.pick(listOf(sharing, working), inCohub = true))
    }
}
