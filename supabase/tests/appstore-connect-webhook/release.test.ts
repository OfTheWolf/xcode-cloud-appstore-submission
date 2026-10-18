import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRelease } from "../../functions/appstore-release/release.ts";

const uploadId = "upload-1";
function api(overrides: Record<string, unknown> = {}) {
  const replies: Record<string, unknown> = {
    "buildUploads/upload-1?include=build": { data: { attributes: { platform: "IOS", cfBundleShortVersionString: "2.0", cfBundleVersion: "123", uploadedDate: "2026-10-17T13:35:00Z", state: { state: "COMPLETE" } }, relationships: { build: { data: { id: "build-1" } } } },
      included: [{ type: "builds", id: "build-1", attributes: { version: "123", processingState: "VALID", buildAudienceType: "APP_STORE_ELIGIBLE", expired: false } }] },
    "builds/build-1/app": { data: { id: "1234567890" } },
    "ciWorkflows/archive/buildRuns?sort=-number&include=sourceBranchOrTag%2Cbuilds&limit=100": { data: [{ id: "source-run", attributes: { number: 123, startedDate: "2026-10-17T13:30:00Z", finishedDate: "2026-10-17T13:40:00Z", completionStatus: "SUCCEEDED", isPullRequestBuild: false, sourceCommit: { commitSha: "a".repeat(40) } }, relationships: { sourceBranchOrTag: { data: { id: "main" } } } }], included: [{ id: "main", type: "scmGitReferences", attributes: { canonicalName: "refs/heads/main" } }] },
    "apps/1234567890/appStoreVersions?filter%5Bplatform%5D=IOS&filter%5BversionString%5D=2.0": { data: [] },
    ...overrides,
  };
  return async (path: string) => { assert.ok(path in replies, path); return structuredClone(replies[path]); };
}
test("resolves the exact processed build and source commit", async () => {
  assert.deepEqual(await resolveRelease(api(), uploadId, "archive"), {
    build_id: "build-1", build_number: "123", version: "2.0", source_run_id: "source-run", source_sha: "a".repeat(40),
  });
});
test("rejects an upload for another app", async () => {
  await assert.rejects(resolveRelease(api({ "builds/build-1/app": { data: { id: "other" } } }), uploadId, "archive"), /another app/);
});
test("does not change a version already waiting for review", async () => {
  assert.equal(await resolveRelease(api({
    "apps/1234567890/appStoreVersions?filter%5Bplatform%5D=IOS&filter%5BversionString%5D=2.0": { data: [{ attributes: { appVersionState: "WAITING_FOR_REVIEW" } }] },
  }), uploadId, "archive"), null);
});
test("retries when the originating Xcode Cloud run is not yet available", async () => {
  await assert.rejects(resolveRelease(api({
    "ciWorkflows/archive/buildRuns?sort=-number&include=sourceBranchOrTag%2Cbuilds&limit=100": { data: [] },
  }), uploadId, "archive"), /not ready/);
});
test("ignores builds from a feature branch", async () => {
  const key = "ciWorkflows/archive/buildRuns?sort=-number&include=sourceBranchOrTag%2Cbuilds&limit=100";
  const response = await api()(key) as any;
  response.included[0].attributes.canonicalName = "refs/heads/feature";
  assert.equal(await resolveRelease(api({ [key]: response }), uploadId, "archive"), null);
});
test("does not map an upload to a run with a different number", async () => {
  const key = "ciWorkflows/archive/buildRuns?sort=-number&include=sourceBranchOrTag%2Cbuilds&limit=100";
  const response = await api()(key) as any;
  response.data[0].attributes.number = 122;
  await assert.rejects(resolveRelease(api({ [key]: response }), uploadId, "archive"), /not ready/);
});
test("rejects a reused number outside the source run's upload window", async () => {
  const key = "ciWorkflows/archive/buildRuns?sort=-number&include=sourceBranchOrTag%2Cbuilds&limit=100";
  const response = await api()(key) as any;
  response.data[0].attributes.startedDate = "2026-10-16T13:30:00Z";
  response.data[0].attributes.finishedDate = "2026-10-16T13:40:00Z";
  await assert.rejects(resolveRelease(api({ [key]: response }), uploadId, "archive"), /time mismatch/);
});
