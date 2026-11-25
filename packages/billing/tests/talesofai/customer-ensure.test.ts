import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBusinessBillingOperations,
  createTalesofaiBillingOperations,
} from "../../src/client.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("customer ensure never requests an active status transition", async () => {
  const originalFetch = globalThis.fetch;
  const customerCreates: Record<string, unknown>[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/customers" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      customerCreates.push(body);
      return response({
        customer: {
          id: `customer_${customerCreates.length}`,
          external_user_id: body.external_user_id,
          status: "active",
          meta: {},
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        },
      });
    }
    if (
      url.pathname === "/v1/customers/business_user/state" &&
      method === "GET"
    ) {
      return response({
        customer: {
          id: "customer_2",
          external_user_id: "business_user",
          status: "active",
          meta: {},
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        },
        business_key: "space_1",
        active_benefits: [],
        credits: [],
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    const platformOperations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    await platformOperations.ensureCustomer({ userId: "platform_user" });

    const businessOperations = createBusinessBillingOperations({
      clientConfig: {
        baseUrl: "https://billing.example.test/v1",
        adminApiKey: "test-key",
      },
      businessKey: "space_1",
    });
    await businessOperations.getEntitlements({ userId: "business_user" });

    assert.deepEqual(customerCreates, [
      { external_user_id: "platform_user" },
      { external_user_id: "business_user" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
