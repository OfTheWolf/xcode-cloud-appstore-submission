#!/bin/sh
set -eu

if [ "${CI_WORKFLOW:-}" != "Submit App Store Release" ]; then
  exit 0
fi
if [ "${CI_XCODEBUILD_EXIT_CODE:-1}" != "0" ]; then
  echo "Submission utility build failed; submission skipped."
  exit 1
fi
: "${ASC_RELEASE_WORKER_TOKEN:?Set this secret in the Submit App Store Release workflow}"
: "${CI_PRIMARY_REPOSITORY_PATH:?Missing Xcode Cloud repository path}"
exec python3 "$CI_PRIMARY_REPOSITORY_PATH/ios/scripts/submit_app_store.py"
