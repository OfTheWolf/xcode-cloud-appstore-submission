#!/usr/bin/env python3
"""Submit an existing Xcode Cloud build. Uses only Python's standard library."""
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

APP_ID = "1234567890"
BROKER = "https://abcdefghijklmnopqrst.supabase.co/functions/v1/appstore-release"
EDITABLE = {"PREPARE_FOR_SUBMISSION", "REJECTED", "DEVELOPER_REJECTED", "METADATA_REJECTED", "READY_FOR_REVIEW"}
FILES = {"release_notes.txt": "whatsNew", "promotional_text.txt": "promotionalText",
         "description.txt": "description", "keywords.txt": "keywords"}


def request_json(url, token, method="GET", body=None):
    # Clipboard newlines must never reach http.client, whose exception echoes headers.
    token = token.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", token):
        raise ValueError("Invalid API credential format")
    request = urllib.request.Request(url, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        # Apple's error codes help diagnose missing review metadata without logging credentials.
        try:
            codes = ", ".join(item.get("code", "unknown") for item in json.loads(error.read()).get("errors", []))
        except (ValueError, TypeError):
            codes = ""
        raise RuntimeError("API HTTP %s %s" % (error.code, codes)) from None


def validate_manifest(job, manifest, metadata):
    if manifest.get("enabled") is not True:
        return False
    if manifest.get("appId") != APP_ID:
        raise ValueError("Wrong manifest appId")
    if manifest.get("version") != job["version"]:
        raise ValueError("Build and manifest version differ")
    if manifest.get("releaseType") not in {"MANUAL", "AFTER_APPROVAL"}:
        raise ValueError("Unsupported releaseType")
    locales = manifest.get("locales")
    if not isinstance(locales, list) or not locales or len(locales) != len(set(locales)):
        raise ValueError("Expected distinct metadata locales")
    for locale in locales:
        values = metadata.get(locale, {})
        for name, limit in [("whatsNew", 4000), ("promotionalText", 170), ("description", 4000), ("keywords", 100)]:
            value = values.get(name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Missing %s for %s" % (name, locale))
            length = len(value.encode("utf-8")) if name == "keywords" else len(value)
            if length > limit:
                raise ValueError("%s exceeds limit for %s" % (name, locale))
    return True


def submit_release(apple, job, manifest, metadata, dry_run=False):
    if not validate_manifest(job, manifest, metadata):
        return "skipped"
    build = apple("builds/%s?include=app,preReleaseVersion" % job["build_id"])
    resource = build["data"]
    attributes = resource["attributes"]
    pre_id = resource["relationships"]["preReleaseVersion"]["data"]["id"]
    pre = next(item for item in build["included"] if item["type"] == "preReleaseVersions" and item["id"] == pre_id)
    if (resource["relationships"]["app"]["data"]["id"] != APP_ID or
        attributes["version"] != job["build_number"] or pre["attributes"]["version"] != job["version"] or
        pre["attributes"]["platform"] != "IOS" or attributes["processingState"] != "VALID" or
        attributes.get("expired") or attributes.get("buildAudienceType") != "APP_STORE_ELIGIBLE"):
        raise ValueError("Build identity or eligibility check failed")
    if attributes.get("usesNonExemptEncryption") is None:
        raise ValueError("Export compliance must be completed before submission")
    query = urllib.parse.urlencode({"filter[platform]": "IOS", "filter[versionString]": job["version"]})
    versions = apple("apps/%s/appStoreVersions?%s" % (APP_ID, query))["data"]
    if len(versions) > 1:
        raise ValueError("Ambiguous App Store version")
    version = versions[0] if versions else None
    if version and version["attributes"]["appVersionState"] not in EDITABLE:
        print("Version %s is already in review or released; leaving it alone." % job["version"])
        return "skipped"
    print("Release %s (%s): %s; locales: %s" % (job["version"], job["build_number"],
        manifest["releaseType"], ", ".join(manifest["locales"])))
    if dry_run:
        print("Validation only: no metadata, build selection, or submission changed.")
        return "validated"
    if version is None:
        version = apple("appStoreVersions", "POST", {"data": {"type": "appStoreVersions",
            "attributes": {"platform": "IOS", "versionString": job["version"],
                "copyright": manifest.get("copyright", "Your Company"), "releaseType": manifest["releaseType"]},
            "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]
    version_id = version["id"]
    localized = apple("appStoreVersions/%s/appStoreVersionLocalizations?limit=200" % version_id)["data"]
    by_locale = {item["attributes"]["locale"]: item["id"] for item in localized}
    for locale in manifest["locales"]:
        if locale in by_locale:
            localization_id = by_locale[locale]
            apple("appStoreVersionLocalizations/" + localization_id, "PATCH", {"data": {
                "type": "appStoreVersionLocalizations", "id": localization_id, "attributes": metadata[locale]}})
        else:
            apple("appStoreVersionLocalizations", "POST", {"data": {"type": "appStoreVersionLocalizations",
                "attributes": dict(metadata[locale], locale=locale),
                "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}}}})
    apple("appStoreVersions/" + version_id, "PATCH", {"data": {"type": "appStoreVersions", "id": version_id,
        "attributes": {"releaseType": manifest["releaseType"]},
        "relationships": {"build": {"data": {"type": "builds", "id": job["build_id"]}}}}})
    # Reuse a draft only if it already contains this exact app version. Never edit unrelated submissions.
    query = urllib.parse.urlencode({"filter[app]": APP_ID, "filter[platform]": "IOS", "limit": "200"})
    submissions = apple("reviewSubmissions?" + query)["data"]
    review_id = None
    for review in submissions:
        if review["attributes"]["state"] != "READY_FOR_REVIEW":
            continue
        items = apple("reviewSubmissions/%s/items?include=appStoreVersion&limit=200" % review["id"])["data"]
        if any(item.get("relationships", {}).get("appStoreVersion", {}).get("data", {}).get("id") == version_id for item in items):
            if len(items) != 1:
                raise ValueError("Review draft contains other items; inspect it manually")
            review_id = review["id"]
            break
        if not items:
            raise ValueError("An empty review draft exists; inspect it before retrying")
    if review_id is None:
        review_id = apple("reviewSubmissions", "POST", {"data": {"type": "reviewSubmissions",
            "attributes": {"platform": "IOS"}, "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]["id"]
        apple("reviewSubmissionItems", "POST", {"data": {"type": "reviewSubmissionItems", "relationships": {
            "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": review_id}},
            "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}}}})
    apple("reviewSubmissions/" + review_id, "PATCH", {"data": {"type": "reviewSubmissions", "id": review_id,
        "attributes": {"submitted": True}}})
    return "submitted"


def load_release(repo, sha):
    if not re.fullmatch(r"[a-fA-F0-9]{40}", sha):
        raise ValueError("Invalid source commit")
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode("utf-8")
    try:
        git("cat-file", "-e", sha + "^{commit}")
    except subprocess.CalledProcessError:
        git("fetch", "--no-tags", "origin", sha)
    try:
        manifest = json.loads(git("show", sha + ":ios/fastlane/release.json"))
    except subprocess.CalledProcessError:
        print("No release manifest in source commit; skipping.")
        return {"enabled": False}, {}
    metadata = {}
    for locale in manifest.get("locales", []):
        if not isinstance(locale, str) or not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?", locale):
            raise ValueError("Invalid locale")
        metadata[locale] = {field: git("show", "%s:ios/fastlane/metadata/%s/%s" % (sha, locale, filename)).rstrip("\n")
            for filename, field in FILES.items()}
    return manifest, metadata


def main():
    if os.environ.get("CI_WORKFLOW") != "Submit App Store Release":
        raise RuntimeError("Run this script only in Submit App Store Release")
    run_id = os.environ["CI_BUILD_ID"]
    secret = os.environ["ASC_RELEASE_WORKER_TOKEN"]
    def broker(action, body):
        return request_json(BROKER + "/" + action, secret, "POST", dict(body, runId=run_id))
    response = None
    for attempt in range(12):
        try:
            response = broker("claim", {})
            break
        except RuntimeError as error:
            if "HTTP 409" not in str(error) or attempt == 11:
                raise
            time.sleep(5)
    if not response or "job" not in response:
        print("No active submission job for this run.")
        return
    job = response["job"]
    try:
        repo = Path(os.environ.get("CI_PRIMARY_REPOSITORY_PATH", str(Path(__file__).resolve().parents[2])))
        manifest, metadata = load_release(repo, job["source_sha"])
        def apple(path, method="GET", body=None):
            return request_json("https://api.appstoreconnect.apple.com/v1/" + path, response["appleToken"], method, body)
        result = submit_release(apple, job, manifest, metadata, dry_run=response.get("validationOnly", True))
        # A validation job remains skipped; it never claims a submission occurred.
        broker("finish", {"state": "skipped" if result == "validated" else result})
        print("Submission job finished: " + result)
    except Exception:
        broker("finish", {"state": "failed"})
        raise


if __name__ == "__main__":
    main()
