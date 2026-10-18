import { createAppStoreConnectWebhook } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const secret = Deno.env.get("ASC_WEBHOOK_SECRET");
if (!url || !serviceKey || !secret) throw new Error("Missing webhook configuration");
const headers: Record<string, string> = {
  apikey: serviceKey, "content-type": "application/json",
  Prefer: "resolution=ignore-duplicates,return=minimal",
};
if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;

Deno.serve(createAppStoreConnectWebhook({
  secret,
  record: async event => {
    const response = await fetch(`${url}/rest/v1/asc_build_events?on_conflict=event_id`, {
      method: "POST", headers,
      body: JSON.stringify({ event_id: event.eventId, event_type: event.eventType,
        instance_id: event.instanceId, state: event.state, payload: event.payload }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Storage HTTP ${response.status}`);
  },
}));
