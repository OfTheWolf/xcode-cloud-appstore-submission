# Xcode Cloud builds the app. A second workflow submits it.

Companion scripts for an article about automating App Store metadata and review
submission with Xcode Cloud, an App Store Connect webhook, and Supabase.

This is a generic reference implementation with dummy identifiers and sample
metadata. Its included tests run without Apple or Supabase credentials. Validate
the integration in your own account before enabling actual submissions.

```text
Release commit → Xcode Cloud archive/upload → Apple processing completes
→ signed webhook → Supabase queue → scheduled dispatcher
→ second Xcode Cloud workflow → original commit's metadata → App Review
```

The second workflow uses an aggregate target, so it doesn't rebuild the app.
Release notes, promotional text, descriptions and keywords come from the archive's
source commit. Already submitted or released versions are skipped. Public release
after approval is manual by default. No cancellation or replacement is automatic.

## 1. Requirements

- An existing iOS app and working Xcode Cloud archive/upload workflow.
- A connected Git repository with a `main` release branch.
- An App Store Connect team API key with sufficient permissions, its Key ID,
  Issuer ID and `.p8` file. Keep the file outside Git.
- A Supabase project and authenticated Supabase CLI.
- Node.js 22+, Python 3.9+ for the installer, and Xcode for local validation.
- Complete store listing, screenshots, review information, privacy disclosures,
  agreements and export compliance. The script does not create these assets.

Clone this repository, then run the configuration helper to copy its files into
your existing app repository. The template uses dummy app ID `1234567890`, workflow
UUID `00000000-0000-0000-0000-000000000001`, project reference
`abcdefghijklmnopqrst`, and version `2.0.0`. These values do not identify a real
app or Supabase project; the helper replaces them with your supplied values.

```sh
python3 configure.py \
  --destination /path/to/your-app-repository \
  --app-id YOUR_NUMERIC_APP_ID \
  --archive-workflow-id YOUR_ARCHIVE_WORKFLOW_UUID \
  --supabase-project-ref YOUR_PROJECT_REF \
  --version 2.0.0
```

The installer makes no network requests and refuses to overwrite existing files.
If your repository already contains matching files, merge the example manually.
The archive workflow UUID is available in its App Store Connect URL/API response.

## 2. Prepare local credentials

Run subsequent commands from your **app repository root**, not this template repository.
Set these environment variables locally using your own values:

```sh
export APPLE_PRIVATE_KEY_PATH=/absolute/path/to/AuthKey.p8
export APPLE_KEY_ID=YOUR_KEY_ID
export APPLE_ISSUER_ID=YOUR_ISSUER_ID

node supabase/scripts/manage-asc-webhook.mjs prepare
node supabase/scripts/manage-asc-release.mjs prepare
```

These helpers generate local secrets under ignored `supabase/.temp/` with file
mode 600. `.p8` content, generated environment files and generated SQL containing
credentials must never be committed, published in a repository, or printed in logs.

## 3. Deploy the receiver and queue

Link the repository to your Supabase project first. Inspect pending migrations
before applying them; the example adds its own tables and does not migrate yours.

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push --linked --dry-run
supabase db push --linked

supabase secrets set --project-ref YOUR_PROJECT_REF --env-file supabase/.temp/asc-webhook.env
supabase secrets set --project-ref YOUR_PROJECT_REF --env-file supabase/.temp/asc-release.env
supabase functions deploy appstore-connect-webhook --project-ref YOUR_PROJECT_REF --use-api
supabase functions deploy appstore-release --project-ref YOUR_PROJECT_REF --use-api
```

Both functions use `verify_jwt = false` in `supabase/config.toml` because they
authenticate requests themselves: the receiver verifies Apple's raw-body
HMAC-SHA256 signature, and the job broker checks its worker credential.

The SQL migrations enable RLS and deny client access to release tables. Duplicate
events and upload jobs have unique keys. A database claim prevents simultaneous
dispatchers starting the same job.

## 4. Configure Apple and Xcode Cloud

```sh
node supabase/scripts/manage-asc-webhook.mjs register
node supabase/scripts/manage-asc-webhook.mjs deliveries
node supabase/scripts/manage-asc-release.mjs configure
supabase db query --linked --file supabase/.temp/asc-release-config.sql
supabase db query --linked --file supabase/.temp/asc-release-cron.sql
```

The first helper verifies the deployed receiver and registers
`BUILD_UPLOAD_STATE_UPDATED`, then requests an Apple test delivery. Confirm
`SUCCEEDED` with HTTP 200. These are App Store Connect integration events, not
subscription server notifications or Xcode Cloud lifecycle webhooks.

The second helper creates **Submit App Store Release** using the archive workflow's
repository and Xcode/macOS environment. It has a manual main-branch start condition,
a macOS Build action, the `ReleaseAutomation` scheme, and this container:

```text
ios/ReleaseAutomation/ReleaseAutomation.xcodeproj
```

In this new workflow's **Environment** settings, add `ASC_RELEASE_WORKER_TOKEN`,
mark it **Secret**, and Save. Use only the value after `=` from
`supabase/.temp/asc-xcodecloud.env`. Do not use the other environment file, which
contains the Apple signing key. Apple's public workflow API doesn't expose this
secret setting. Copied surrounding whitespace is normalized by the Python worker.

The `.p8` key remains in Supabase secrets. The cloud worker receives a short-lived
Apple JWT only after the broker matches its CI run to an assigned job and workflow.
The worker credential is a release credential; keep it private and rotate it in
Supabase secrets, Vault, and Xcode Cloud together when necessary.

## 5. Prepare metadata and publish the scripts

The sample manifest is installed at `ios/fastlane/release.json`. Set its version
to the app's marketing version. `enabled: false` skips that release; `MANUAL`
requires manual public release after approval; `AFTER_APPROVAL` publishes after
approval automatically.

Replace all sample English metadata. Add other locales and their four metadata
files if desired. This example preserves existing screenshots, app name and subtitle.

Commit the automation, app version, manifest and release text to your repository.
Push to main before trying to run the submission workflow. The archive pipeline
can run normally; the dispatcher is initially disabled.

## 6. Validate, then activate

```sh
node --experimental-strip-types --no-warnings --test supabase/tests/appstore-connect-webhook/handler.test.ts supabase/tests/appstore-connect-webhook/release.test.ts
python3 -m unittest discover -s ios/scripts/release-tests -v
supabase db query --linked --file supabase/tests/appstore-connect-webhook/queue.sql
xcodebuild -project ios/ReleaseAutomation/ReleaseAutomation.xcodeproj -scheme ReleaseAutomation -destination 'generic/platform=macOS' build CODE_SIGNING_ALLOWED=NO
```

First enable dispatch with App Store mutations disabled:

```sql
update public.asc_release_config
set enabled = true, validation_only = true where id = true;
```

Produce an eligible main-branch archive whose version is editable in App Store
Connect. Wait for processing and the next five-minute queue tick. Inspect the
submission workflow's logs and the job table. Manually starting the workflow
without an assigned job is not a submission test. A version already in review is
skipped before dispatch, so it won't exercise the cloud worker.

When validation succeeds, reset **only your skipped validation job** to `pending`
with `ci_run_id = null`, `attempts = 0`, and switch `validation_only` to false if
you intend that exact build to be submitted; alternatively leave it skipped and
activate actual submissions for the next release:

```sql
update public.asc_release_config
set enabled = true, validation_only = false where id = true;
```

This last change enables real App Store metadata writes and review submissions.
It does not publish an app immediately; the manifest's release policy applies.

## Monitoring and recovery

```sql
select upload_id, version, build_number, state, attempts, ci_run_id, last_error
from public.asc_release_jobs order by created_at desc limit 20;
```

Temporary build-resolution errors retry up to 12 times. An ambiguous start-build
response remains `dispatching` for manual reconciliation; blindly retrying could
start another run. Failed cloud jobs need inspection rather than an automatic
resubmission loop. Don't reset jobs already submitted.

The resolver checks the source workflow, main branch, successful run, build number,
upload time and explicit build linkage when populated. Build relationships and filters may be incomplete. Test this matching strategy
with your account; don't remove identity checks to get past a mismatch.

To pause dispatch:

```sql
update public.asc_release_config set enabled = false where id = true;
```

Supabase's five-minute scheduler uses about 8,640 invocations in a 30-day month,
plus webhook and cloud-worker calls. Check current quotas, free-project pausing
and your separate Xcode Cloud usage allowance.

References: [Apple webhooks](https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications),
[custom build scripts](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts),
[start a cloud build](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-cibuildruns).
