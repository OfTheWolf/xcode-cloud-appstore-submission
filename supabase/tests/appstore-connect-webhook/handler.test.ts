import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppStoreConnectWebhook } from "../../functions/appstore-connect-webhook/handler.ts";

const secret = "test-only-webhook-secret";
const event = { data: { type: "buildUploadStateUpdated", id: "event-1", version: 1,
  attributes: { newState: "COMPLETE" },
  relationships: { instance: { data: { type: "buildUploads", id: "upload-1" } } } } };
async function request(body = JSON.stringify(event), signingSecret = secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(body))), b => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://example.com", { method: "POST", body,
    headers: { "x-apple-signature": `hmacsha256=${signature}` } });
}
test("stores an authenticated completed build event", async () => {
  const stored: unknown[] = [];
  const handler = createAppStoreConnectWebhook({ secret, record: async e => { stored.push(e); } });
  assert.equal((await handler(await request())).status, 200);
  assert.deepEqual(stored, [{ eventId: "event-1", eventType: "buildUploadStateUpdated",
    instanceId: "upload-1", state: "COMPLETE", payload: event }]);
});
test("rejects missing or forged signatures without storing", async () => {
  let count = 0;
  const handler = createAppStoreConnectWebhook({ secret, record: async () => { count++; } });
  assert.equal((await handler(new Request("https://example.com", { method: "POST", body: "{}" }))).status, 401);
  assert.equal((await handler(await request(undefined, "wrong-secret"))).status, 401);
  assert.equal(count, 0);
});
test("acknowledges Apple's ping without queuing a release", async () => {
  const handler = createAppStoreConnectWebhook({ secret, record: async () => { assert.fail("stored ping"); } });
  assert.equal((await handler(await request(JSON.stringify({ data: { type: "webhookPing", id: "ping-1" } })))).status, 200);
});
test("records failure states so operators can diagnose uploads", async () => {
  let state: string | undefined;
  const handler = createAppStoreConnectWebhook({ secret, record: async e => { state = e.state; } });
  const failed = structuredClone(event);
  failed.data.attributes.newState = "FAILED";
  assert.equal((await handler(await request(JSON.stringify(failed)))).status, 200);
  assert.equal(state, "FAILED");
});
test("returns retryable failure when durable storage is unavailable", async () => {
  const handler = createAppStoreConnectWebhook({ secret, record: async () => { throw new Error("offline"); } });
  assert.equal((await handler(await request())).status, 503);
});
test("rejects malformed signed events and oversized bodies", async () => {
  const handler = createAppStoreConnectWebhook({ secret, record: async () => { assert.fail("stored bad input"); } });
  assert.equal((await handler(await request("{"))).status, 400);
  assert.equal((await handler(await request(JSON.stringify({ data: { type: "buildUploadStateUpdated" } })))).status, 400);
  assert.equal((await handler(await request("x".repeat(65_537)))).status, 413);
});
test("does not accept methods other than POST", async () => {
  const handler = createAppStoreConnectWebhook({ secret, record: async () => {} });
  assert.equal((await handler(new Request("https://example.com"))).status, 405);
});
