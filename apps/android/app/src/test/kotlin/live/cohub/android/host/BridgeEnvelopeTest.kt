package live.cohub.android.host

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

class BridgeEnvelopeTest {
    private val fixture = Json.parseToJsonElement(File(FIXTURE).readText()).jsonObject

    private fun cases(key: String): List<JsonObject> = fixture.getValue(key).jsonArray.map { it.jsonObject }

    private val JsonObject.name get() = getValue("name").jsonPrimitive.content

    @Test
    fun `parses requests`() {
        for (item in cases("requests")) {
            val parsed = BridgeRequest.parse(item.getValue("text").jsonPrimitive.content)
            val expected = item["request"] as? JsonObject
            if (expected == null) {
                assertNull(item.name, parsed)
                continue
            }
            assertEquals(item.name, expected.getValue("id").jsonPrimitive.content, parsed?.id)
            assertEquals(item.name, expected.getValue("method").jsonPrimitive.content, parsed?.method)
            assertEquals(item.name, expected.getValue("params"), parsed?.params ?: JsonNull)
        }
    }

    @Test
    fun `serialises replies`() {
        for (item in cases("replies")) {
            val id = item.getValue("id").jsonPrimitive.content
            val error = item["error"] as? JsonObject
            val text = if (error != null) {
                BridgeMessages.error(id, error.getValue("code").jsonPrimitive.content, error.getValue("message").jsonPrimitive.content)
            } else {
                BridgeMessages.result(id, item["result"] ?: JsonNull)
            }
            assertEquals(item.name, item.getValue("json"), Json.parseToJsonElement(text))
        }
    }

    @Test
    fun `serialises events`() {
        for (item in cases("events")) {
            val text = BridgeMessages.event(item.getValue("event").jsonPrimitive.content, item["payload"])
            assertEquals(item.name, item.getValue("json"), Json.parseToJsonElement(text))
        }
    }

    private companion object {
        const val FIXTURE = "../../../packages/protocol/fixtures/host-bridge.json"
    }
}
