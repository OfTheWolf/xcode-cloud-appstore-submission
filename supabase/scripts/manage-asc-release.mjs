// Repository-root setup helper. Secrets are written only to ignored mode-600 files.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, sign } from 'node:crypto';
const sourceWorkflow = '00000000-0000-0000-0000-000000000001';
const action = process.argv[2] ?? 'inspect';
if (!['inspect', 'configure', 'prepare'].includes(action)) throw new Error('Use inspect, configure, or prepare');
const keyId = process.env.APPLE_KEY_ID;
const issuer = process.env.APPLE_ISSUER_ID;
if (!keyId || !issuer || !process.env.APPLE_PRIVATE_KEY_PATH) throw new Error('Set APPLE_KEY_ID, APPLE_ISSUER_ID and APPLE_PRIVATE_KEY_PATH');
const privateKey = readFileSync(process.env.APPLE_PRIVATE_KEY_PATH);
if (action === 'prepare') {
  mkdirSync('supabase/.temp', { recursive: true, mode: 0o700 });
  const workerPath = 'supabase/.temp/asc-xcodecloud.env';
  if (!existsSync(workerPath)) writeFileSync(workerPath,
    `ASC_RELEASE_WORKER_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  const worker = readFileSync(workerPath, 'utf8').trim();
  if (!/^ASC_RELEASE_WORKER_TOKEN=[a-f0-9]{64}$/.test(worker)) throw new Error('Invalid saved worker secret');
  writeFileSync('supabase/.temp/asc-release.env', worker + '\n' +
    `ASC_PRIVATE_KEY_BASE64=${privateKey.toString('base64')}\nASC_KEY_ID=${keyId}\nASC_ISSUER_ID=${issuer}\n`, { mode: 0o600 });
  // Keep secrets out of command arguments and CLI output when setting up Vault.
  const secret = worker.split('=')[1];
  writeFileSync('supabase/.temp/asc-release-cron.sql', `
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
do $setup$
declare saved_id uuid;
begin
  select id into saved_id from vault.secrets where name = 'asc_release_worker_token';
  if saved_id is null then
    perform vault.create_secret('${secret}', 'asc_release_worker_token', 'Authenticates the App Store release dispatcher');
  else
    perform vault.update_secret(saved_id, '${secret}');
  end if;
end;
$setup$;
select cron.schedule('asc-release-dispatch', '*/5 * * * *', $dispatch$
  select net.http_post(
    url := 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/appstore-release/dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'asc_release_worker_token')),
    body := '{}'::jsonb, timeout_milliseconds := 100000
  );
$dispatch$);
`, { mode: 0o600 });
  console.log('Supabase secrets, Vault/cron setup, and Xcode Cloud secret prepared in ignored supabase/.temp files. No values displayed.');
  process.exit(0);
}
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const now = Math.floor(Date.now()/1000);
const input = enc({ alg: 'ES256', kid: keyId, typ: 'JWT' }) + '.' + enc({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const jwt = input + '.' + sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
async function apple(path, method='GET', body) {
  const response = await fetch('https://api.appstoreconnect.apple.com/v1/' + path, { method,
    headers: { Authorization: 'Bearer '+jwt, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Apple HTTP ${response.status}: ` + data.errors?.map(e=>`${e.code}: ${e.detail}`).join('; '));
  return data;
}
const original = (await apple(`ciWorkflows/${sourceWorkflow}?include=product,repository,xcodeVersion,macOsVersion`)).data;
const productId = original.relationships.product.data.id;
const repository = original.relationships.repository.data;
const refs = (await apple(`scmRepositories/${repository.id}/gitReferences?limit=200`)).data;
const main = refs.find(ref => ref.attributes.canonicalName === 'refs/heads/main' && !ref.attributes.isDeleted);
if (!main) throw new Error('Main branch reference not found');
let workflow = (await apple(`ciProducts/${productId}/workflows?limit=200`)).data.find(w => w.attributes.name === 'Submit App Store Release');
if (action === 'configure' && !workflow) {
  workflow = (await apple('ciWorkflows', 'POST', { data: { type: 'ciWorkflows', attributes: {
    name: 'Submit App Store Release', description: 'Submit an already-uploaded build using metadata from its source commit. Triggered by Supabase.',
    clean: false, isEnabled: true,
    containerFilePath: 'ios/ReleaseAutomation/ReleaseAutomation.xcodeproj',
    manualBranchStartCondition: { source: { isAllMatch: false, patterns: [{ pattern: 'main', isPrefix: false }] } },
    actions: [{ name: 'Submit existing App Store build', actionType: 'BUILD', scheme: 'ReleaseAutomation', platform: 'MACOS', destination: 'ANY_MAC', isRequiredToPass: true }],
  }, relationships: { product: { data: { type: 'ciProducts', id: productId } }, repository: { data: repository },
    xcodeVersion: original.relationships.xcodeVersion, macOsVersion: original.relationships.macOsVersion } } })).data;
}
console.log(JSON.stringify({ sourceWorkflow, submissionWorkflowId: workflow?.id ?? null, mainRefId: main.id,
  submissionWorkflow: workflow?.attributes }, null, 2));
if (action === 'configure') {
  mkdirSync('supabase/.temp', { recursive: true, mode: 0o700 });
  writeFileSync('supabase/.temp/asc-release-config.sql', `update public.asc_release_config set submission_workflow_id = '${workflow.id}', submission_ref_id = '${main.id}' where id = true;\n`, { mode: 0o600 });
}
