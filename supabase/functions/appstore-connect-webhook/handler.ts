export interface BuildEvent {
  eventId: string;
  eventType: "buildUploadStateUpdated";
  instanceId: string;
  state: string;
  payload: unknown;
}

export function createAppStoreConnectWebhook(options: {
  secret: string;
  record: (event: BuildEvent) => Promise<void>;
}) {
  if (!options.secret) throw new Error("Webhook secret is required");
  const encoder = new TextEncoder();
  const key = crypto.subtle.importKey("raw", encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const signature = /^hmacsha256=([a-f0-9]{64})$/i.exec(request.headers.get("x-apple-signature") ?? "");
    if (!signature) return new Response("Unauthorized", { status: 401 });
    // Enforce a byte limit while streaming, including requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return new Response("Missing body", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) {
          await reader.cancel();
          return new Response("Body too large", { status: 413 });
        }
        chunks.push(value);
      }
    } catch {
      return new Response("Invalid body", { status: 400 });
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const digest = Uint8Array.from(signature[1].match(/../g)!, byte => parseInt(byte, 16));
    if (!await crypto.subtle.verify("HMAC", await key, digest, body)) {
      return new Response("Unauthorized", { status: 401 });
    }
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(body)); }
    catch { return new Response("Invalid JSON", { status: 400 }); }
    const data = payload?.data;
    if (data?.type === "webhookPing") return new Response("pong");
    if (data?.type !== "buildUploadStateUpdated") return new Response("Ignored");
    const instance = data.relationships?.instance?.data;
    const state = data.attributes?.newState;
    if (typeof data.id !== "string" || !data.id || data.id.length > 200 ||
      instance?.type !== "buildUploads" || typeof instance.id !== "string" || !instance.id || instance.id.length > 200 ||
      !["AWAITING_UPLOAD", "PROCESSING", "FAILED", "COMPLETE"].includes(state)) {
      return new Response("Invalid build event", { status: 400 });
    }
    try {
      await options.record({ eventId: data.id, eventType: data.type, instanceId: instance.id, state, payload });
      return new Response("Recorded");
    } catch {
      // Do not acknowledge until the event is durable; never log secrets or payloads.
      console.error("App Store Connect webhook storage failed");
      return new Response("Storage unavailable", { status: 503 });
    }
  };
}
