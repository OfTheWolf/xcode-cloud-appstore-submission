#!/usr/bin/env python3
"""Copy this generic template into your existing iOS/Supabase repository. No API calls."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--destination", type=Path, required=True)
parser.add_argument("--app-id", required=True, help="Numeric App Store Connect app ID")
parser.add_argument("--archive-workflow-id", required=True)
parser.add_argument("--supabase-project-ref", required=True)
parser.add_argument("--version", default="2.0.0")
args = parser.parse_args()
if not re.fullmatch(r"\d+", args.app_id):
    parser.error("--app-id must be numeric")
if not re.fullmatch(r"[a-fA-F0-9-]{36}", args.archive_workflow_id):
    parser.error("--archive-workflow-id must be a UUID")
if not re.fullmatch(r"[a-z]{20}", args.supabase_project_ref):
    parser.error("--supabase-project-ref must be a 20-letter project reference")
if not re.fullmatch(r"\d+(?:\.\d+){0,2}", args.version):
    parser.error("--version must be a numeric app version")
source = Path(__file__).resolve().parent
destination = args.destination.expanduser().resolve()
mapping = {path: path for path in ['supabase/functions/appstore-connect-webhook/handler.ts', 'supabase/functions/appstore-connect-webhook/index.ts', 'supabase/functions/appstore-release/release.ts', 'supabase/functions/appstore-release/index.ts', 'ios/scripts/submit_app_store.py', 'ios/ReleaseAutomation/ReleaseAutomation.xcodeproj/project.pbxproj', 'ios/ReleaseAutomation/ReleaseAutomation.xcodeproj/xcshareddata/xcschemes/ReleaseAutomation.xcscheme', 'ios/ReleaseAutomation/ci_scripts/ci_post_xcodebuild.sh', 'supabase/migrations/20261017120000_asc_build_events.sql', 'supabase/migrations/20261017130000_asc_release_jobs.sql', 'supabase/scripts/manage-asc-webhook.mjs', 'supabase/scripts/manage-asc-release.mjs', 'ios/scripts/release-tests/test_submission.py', 'supabase/tests/appstore-connect-webhook/handler.test.ts', 'supabase/tests/appstore-connect-webhook/release.test.ts', 'supabase/tests/appstore-connect-webhook/queue.sql', 'ios/fastlane/release.json', 'ios/fastlane/metadata/en-US/release_notes.txt', 'ios/fastlane/metadata/en-US/promotional_text.txt', 'ios/fastlane/metadata/en-US/description.txt', 'ios/fastlane/metadata/en-US/keywords.txt']}
mapping["README.md"] = "APP_STORE_RELEASE_SETUP.md"
for filename, relative in mapping.items():
    target = destination / relative
    if not target.is_relative_to(destination):
        parser.error("Invalid template path")
    if target.exists():
        parser.error("Refusing to overwrite existing file: " + str(target))
    if not (source / filename).is_file():
        parser.error("Missing template file: " + filename)
replacements = {
    "1234567890": args.app_id,
    "00000000-0000-0000-0000-000000000001": args.archive_workflow_id,
    "abcdefghijklmnopqrst": args.supabase_project_ref,
    "2.0.0": args.version,
}
for filename, relative in mapping.items():
    target = destination / relative
    content = (source / filename).read_text()
    if filename != "README.md":
        for placeholder, value in replacements.items():
            content = content.replace(placeholder, value)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    if target.suffix == ".sh":
        target.chmod(0o755)
config = destination / "supabase/config.toml"
content = config.read_text() if config.exists() else 'project_id = "app-store-release"\n'
for name in ["appstore-connect-webhook", "appstore-release"]:
    section = "[functions." + name + "]"
    if section not in content:
        content += "\n" + section + "\nverify_jwt = false\n"
config.write_text(content)
ignore = destination / ".gitignore"
content = ignore.read_text() if ignore.exists() else ""
content += "\n# App Store release credentials and local artifacts\nsupabase/.temp/\n*.p8\n__pycache__/\n"
ignore.write_text(content)
print("Installed the example into " + str(destination))
print("Replace the sample metadata, then follow APP_STORE_RELEASE_SETUP.md. Nothing was deployed or submitted.")
