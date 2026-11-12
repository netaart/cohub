import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMetaPromotionPayload } from "./app-promotion-meta-payload.js";

const event = {
  eventKey: "ready" as const,
  eventId: "event-1",
  appId: "work-1",
  promotionId: "promotion-1",
};

describe("buildMetaPromotionPayload", () => {
  it("omits test_event_code by default", () => {
    const payload = buildMetaPromotionPayload({
      eventName: "ViewContent",
      eventTime: 1_700_000_000,
      event,
      userData: {},
      customData: {},
    });

    assert.equal("test_event_code" in payload, false);
    assert.deepEqual(payload.data[0]?.custom_data, {
      content_ids: ["work-1"],
      content_type: "product",
    });
  });

  it("includes a configured Meta test event code", () => {
    const payload = buildMetaPromotionPayload({
      eventName: "ViewContent",
      eventTime: 1_700_000_000,
      event,
      sourceUrl: "https://cohub.neta.art/work?cohub_campaign=promotion-1",
      userData: { client_user_agent: "test-agent" },
      customData: { content_ids: ["product-1"], content_type: "product" },
      testEventCode: "TEST89717",
    });

    assert.equal(payload.test_event_code, "TEST89717");
    assert.equal(payload.data[0]?.event_id, "event-1");
    assert.equal(
      payload.data[0]?.event_source_url,
      "https://cohub.neta.art/work?cohub_campaign=promotion-1",
    );
  });
});
