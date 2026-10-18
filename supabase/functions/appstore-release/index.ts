import { appleToken, APP_ID, resolveRelease } from "./release.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const url = required("SUPABASE_URL");
const key = required("SUPABASE_SERVICE_ROLE_KEY");
const workerSecret = required("ASC_RELEASE_WORKER_TOKEN");
const privateKey = atob(required("ASC_PRIVATE_KEY_BASE64"));
const keyId = required("ASC_KEY_ID");
const issuer = required("ASC_ISSUER_ID");
const dbHeaders: Record<string, string> = { apikey: key, "content-type": "application/json", Prefer: "return=representation" };
if (key.startsWith("eyJ")) dbHeaders.Authorization = `Bearer ${key}`;
async function db(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${url}/rest/v1/${path}`, { method, headers: dbHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Database HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function token() { return await appleToken(privateKey, keyId, issuer); }
async function apple(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Apple HTTP ${response.status}`);
  return response.status === 204 ? null : await response.json();
}
async function patch(uploadId: string, body: Record<string, unknown>) {
  return await db(`asc_release_jobs?upload_id=eq.${encodeURIComponent(uploadId)}`, "PATCH", { ...body, updated_at: new Date().toISOString() });
}
const reply = (body: unknown, status = 200) => Response.json(body, { status });
const encoder = new TextEncoder();
const expectedAuthHash = await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${workerSecret}`));
async function authorized(request: Request) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")));
  const expected = new Uint8Array(expectedAuthHash);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ hash[i];
  return difference === 0;
}

Deno.serve(async request => {
  if (request.method !== "POST") return reply({ error: "POST required" }, 405);
  if (!await authorized(request)) return reply({ error: "Unauthorized" }, 401);
  try {
    const action = new URL(request.url).pathname.split("/").pop();
    const config = (await db("asc_release_config?id=eq.true"))[0];
    if (!config?.enabled) return reply({ enabled: false });
    if (!config.submission_workflow_id || !config.submission_ref_id) return reply({ error: "Workflow not configured" }, 503);
    if (action === "dispatch") {
      // Resolving is safe to retry; dispatching is intentionally never auto-retried:
      // an ambiguous POST result could otherwise start a second Xcode Cloud run.
      await db(`asc_release_jobs?state=eq.resolving&updated_at=lt.${encodeURIComponent(new Date(Date.now() - 10 * 60_000).toISOString())}`, "PATCH", { state: "pending" });
      const pending = await db("asc_release_jobs?state=eq.pending&attempts=lt.12&order=created_at.asc&limit=1");
      let dispatched = 0;
      for (const pendingJob of pending) {
        const claimed = await db("rpc/claim_asc_dispatch", "POST", { p_upload_id: pendingJob.upload_id });
        if (!claimed.length) continue;
        const job = claimed[0];
        let dispatchStarted = false;
        try {
          const release = await resolveRelease(apple, job.upload_id);
          if (!release) { await patch(job.upload_id, { state: "skipped" }); continue; }
          await patch(job.upload_id, { ...release, state: "dispatching" });
          dispatchStarted = true;
          const run = await apple("ciBuildRuns", "POST", { data: { type: "ciBuildRuns", relationships: {
            workflow: { data: { type: "ciWorkflows", id: config.submission_workflow_id } },
            sourceBranchOrTag: { data: { type: "scmGitReferences", id: config.submission_ref_id } },
          } } });
          await patch(job.upload_id, { state: "dispatched", ci_run_id: run.data.id });
          dispatched++;
        } catch (error) {
          // Error strings contain status codes only, never API response bodies or credentials.
          await patch(job.upload_id, { state: dispatchStarted ? "dispatching" : job.attempts >= 12 ? "failed" : "pending",
            last_error: String(error).slice(0, 200) });
        }
      }
      return reply({ dispatched });
    }
    const input = await request.json();
    if (typeof input.runId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.runId)) return reply({ error: "Invalid run ID" }, 400);
    const runId = input.runId.toLowerCase();
    const run = (await apple(`ciBuildRuns/${runId}?include=workflow,product`)).data;
    if (run.relationships?.workflow?.data?.id?.toLowerCase() !== config.submission_workflow_id.toLowerCase()) return reply({ error: "Wrong workflow" }, 403);
    const jobs = await db(`asc_release_jobs?ci_run_id=eq.${encodeURIComponent(runId)}&limit=1`);
    const job = jobs[0];
    if (!job) return reply({ error: "Job not assigned yet" }, 409);
    if (action === "claim") {
      if (!["dispatched", "running"].includes(job.state)) return reply({ state: job.state });
      if (run.attributes.executionProgress === "COMPLETE") return reply({ error: "Run already finished" }, 409);
      await patch(job.upload_id, { state: "running" });
      return reply({ job, appleToken: await token(), appId: APP_ID, validationOnly: config.validation_only });
    }
    if (action === "finish") {
      if (!["submitted", "skipped", "failed"].includes(input.state) || job.state !== "running") return reply({ error: "Invalid transition" }, 409);
      await patch(job.upload_id, { state: input.state, last_error: input.state === "failed" ? "Submission workflow failed; inspect Xcode Cloud logs" : null });
      return reply({ state: input.state });
    }
    return reply({ error: "Unknown action" }, 404);
  } catch {
    console.error("App Store release operation failed");
    return reply({ error: "Release operation failed" }, 503);
  }
});
