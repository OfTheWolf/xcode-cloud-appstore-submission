// Run from the repository root. Never prints the private key, JWT, or webhook secret.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, sign, createHmac } from 'node:crypto';

const required = name => { if (!process.env[name]) throw new Error('Set ' + name); return process.env[name]; };
const action = process.argv[2] ?? 'check';
const secretPath = 'supabase/.temp/asc-webhook.env';
const appId = '1234567890';
const url = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/appstore-connect-webhook';
const name = 'xcode-cloud-build-upload-events';
if (!['prepare', 'check', 'register', 'test', 'deliveries'].includes(action)) throw new Error('Use prepare, check, register, test, or deliveries');
if (action === 'prepare') {
  mkdirSync('supabase/.temp', { recursive: true, mode: 0o700 });
  if (!existsSync(secretPath)) writeFileSync(secretPath,
    `ASC_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Webhook secret ready in ignored file ${secretPath}; contents are not displayed.`);
  process.exit(0);
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const input = encode({ alg: 'ES256', kid: required('APPLE_KEY_ID'), typ: 'JWT' }) + '.' +
  encode({ iss: required('APPLE_ISSUER_ID'),
    iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const token = input + '.' + sign('sha256', Buffer.from(input), {
  key: readFileSync(required('APPLE_PRIVATE_KEY_PATH')),
  dsaEncoding: 'ieee-p1363',
}).toString('base64url');
async function apple(path, method = 'GET', body) {
  const response = await fetch('https://api.appstoreconnect.apple.com/v1/' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Apple HTTP ${response.status}: ` +
    (data.errors ?? []).map(e => `${e.code}: ${e.title} (${e.source?.parameter ?? 'request'})`).join('; '));
  return data;
}
const app = await apple(`apps/${appId}`);
console.log(`Apple access verified: ${app.data.attributes.name} (${app.data.attributes.bundleId})`);
const existing = await apple(`apps/${appId}/webhooks?limit=200`);
let webhook = existing.data.find(item => item.attributes.url === url || item.attributes.name === name);
if (action === 'check') {
  console.log(JSON.stringify({ webhooks: existing.data.map(item => ({ id: item.id,
    name: item.attributes.name, url: item.attributes.url, enabled: item.attributes.enabled,
    eventTypes: item.attributes.eventTypes })) }, null, 2));
  process.exit(0);
}
if (action === 'register') {
  const secret = readFileSync(secretPath, 'utf8').trim().replace(/^ASC_WEBHOOK_SECRET=/, '');
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid local webhook secret');
  // Verify the endpoint has the same secret before enabling Apple deliveries.
  const ping = JSON.stringify({ data: { type: 'webhookPing', id: 'setup-check' } });
  const probe = await fetch(url, { method: 'POST', body: ping,
    headers: { 'content-type': 'application/json',
      'x-apple-signature': 'hmacsha256=' + createHmac('sha256', secret).update(ping).digest('hex') },
    signal: AbortSignal.timeout(30_000) });
  if (!probe.ok || await probe.text() !== 'pong') throw new Error('Receiver preflight failed; deploy the function and secret first');
  const attributes = { enabled: true, eventTypes: ['BUILD_UPLOAD_STATE_UPDATED'], name, secret, url };
  const result = webhook
    ? await apple(`webhooks/${webhook.id}`, 'PATCH', { data: { type: 'webhooks', id: webhook.id, attributes } })
    : await apple('webhooks', 'POST', { data: { type: 'webhooks', attributes,
      relationships: { app: { data: { type: 'apps', id: appId } } } } });
  webhook = result.data;
  console.log(`Webhook configured: ${webhook.id}`);
}
if (!webhook) throw new Error('Webhook not registered yet');
if (action === 'deliveries') {
  // Apple requires a lower date bound even though the reference marks filters optional.
  const query = new URLSearchParams({ limit: '20', include: 'event',
    'filter[createdDateGreaterThanOrEqualTo]': new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
  const result = await apple(`webhooks/${webhook.id}/deliveries?${query}`);
  console.log(JSON.stringify({ deliveries: result.data.map(item => ({ id: item.id,
    state: item.attributes.deliveryState, sentDate: item.attributes.sentDate,
    httpStatus: item.attributes.response?.httpStatusCode,
    eventId: item.relationships?.event?.data?.id })),
    events: (result.included ?? []).map(item => ({ id: item.id, ping: item.attributes.ping,
      eventType: item.attributes.eventType })) }, null, 2));
  process.exit(0);
}
await apple('webhookPings', 'POST', { data: { type: 'webhookPings',
  relationships: { webhook: { data: { type: 'webhooks', id: webhook.id } } } } });
console.log(`Apple test delivery requested for ${webhook.id}. Verify Recent Deliveries in App Store Connect.`);
