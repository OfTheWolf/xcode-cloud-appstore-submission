export const APP_ID = "1234567890";
export const SOURCE_WORKFLOW = "00000000-0000-0000-0000-000000000001";
export type AppleAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
export interface ReleaseBuild {
  build_id: string;
  build_number: string;
  version: string;
  source_run_id: string;
  source_sha: string;
}

// Null means deliberately ignore; errors are retryable before dispatch begins.
export async function resolveRelease(apple: AppleAPI, uploadId: string, workflow = SOURCE_WORKFLOW): Promise<ReleaseBuild | null> {
  const result = await apple(`buildUploads/${encodeURIComponent(uploadId)}?include=build`);
  const upload = result.data;
  if (upload.attributes.platform !== "IOS") return null;
  if (upload.attributes.state.state !== "COMPLETE") throw new Error("Upload not ready");
  const buildId = upload.relationships?.build?.data?.id;
  const build = result.included?.find((b: any) => b.type === "builds" && b.id === buildId);
  if (!build || build.attributes.processingState !== "VALID") throw new Error("Build not ready");
  if (build.attributes.expired || build.attributes.buildAudienceType !== "APP_STORE_ELIGIBLE") return null;
  if ((await apple(`builds/${buildId}/app`)).data.id !== APP_ID) throw new Error("Upload belongs to another app");
  // Apple's builds relationship/filter can be empty or ignored. Apple documents
  // that distributed Xcode Cloud builds retain the CI run number as CFBundleVersion.
  const query = new URLSearchParams({ sort: "-number", include: "sourceBranchOrTag,builds", limit: "100" });
  const runs = await apple(`ciWorkflows/${workflow}/buildRuns?${query}`);
  const matches = runs.data.filter((r: any) => String(r.attributes.number) === String(upload.attributes.cfBundleVersion));
  if (matches.length !== 1) throw new Error("Source run not ready or ambiguous");
  const run = matches[0];
  const linkedBuilds = run.relationships?.builds?.data ?? [];
  if (linkedBuilds.length && !linkedBuilds.some((b: any) => b.id === buildId)) throw new Error("Source build identity mismatch");
  const branchId = run.relationships?.sourceBranchOrTag?.data?.id;
  const branch = runs.included?.find((b: any) => b.type === "scmGitReferences" && b.id === branchId);
  if (run.attributes.isPullRequestBuild || branch?.attributes.canonicalName !== "refs/heads/main") return null;
  if (run.attributes.completionStatus === "FAILED" || run.attributes.completionStatus === "CANCELED") return null;
  if (run.attributes.completionStatus !== "SUCCEEDED") throw new Error("Source run not ready");
  const uploaded = Date.parse(upload.attributes.uploadedDate);
  const started = Date.parse(run.attributes.startedDate);
  const finished = Date.parse(run.attributes.finishedDate);
  if (!Number.isFinite(uploaded) || !Number.isFinite(started) || !Number.isFinite(finished) ||
    uploaded < started || uploaded > finished + 15 * 60_000) throw new Error("Source upload time mismatch");
  const sha = run.attributes.sourceCommit?.commitSha;
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) throw new Error("Missing source commit");
  const version = upload.attributes.cfBundleShortVersionString;
  const versions = await apple(`apps/${APP_ID}/appStoreVersions?${new URLSearchParams({ "filter[platform]": "IOS", "filter[versionString]": version })}`);
  if (versions.data.some((v: any) => !["PREPARE_FOR_SUBMISSION", "REJECTED", "DEVELOPER_REJECTED", "METADATA_REJECTED", "READY_FOR_REVIEW"].includes(v.attributes.appVersionState))) return null;
  if (String(build.attributes.version) !== String(upload.attributes.cfBundleVersion)) throw new Error("Build number mismatch");
  return { build_id: buildId, build_number: String(build.attributes.version), version,
    source_run_id: run.id, source_sha: sha };
}

export async function appleToken(privateKey: string, keyId: string, issuer: string): Promise<string> {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const bytes = Uint8Array.from(atob(privateKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const input = encode({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." + encode({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)));
  return input + "." + btoa(String.fromCharCode(...sig)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
