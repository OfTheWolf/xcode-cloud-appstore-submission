import importlib.util
from pathlib import Path
import unittest
import json
import subprocess
import tempfile
from unittest.mock import patch
from io import BytesIO

spec = importlib.util.spec_from_file_location("submission", Path(__file__).parents[1] / "submit_app_store.py")
submission = importlib.util.module_from_spec(spec)
spec.loader.exec_module(submission)

JOB = {"build_id": "build-123", "build_number": "123", "version": "2.0", "source_sha": "a" * 40}
MANIFEST = {"enabled": True, "appId": "1234567890", "version": "2.0", "releaseType": "MANUAL", "locales": ["en-US"]}
METADATA = {"en-US": {"whatsNew": "Improved performance.", "promotionalText": "Explore the latest improvements.", "description": "A sample application.", "keywords": "example,app"}}

class Apple:
    def __init__(self, state="PREPARE_FOR_SUBMISSION"):
        self.state = state
        self.writes = []
    def __call__(self, path, method="GET", body=None):
        if method != "GET":
            self.writes.append((path, method, body))
            if path == "reviewSubmissions": return {"data": {"id": "review-1"}}
            return {"data": {"id": "written"}}
        if path.startswith("builds/"):
            return {"data": {"id": "build-123", "attributes": {"version": "123", "processingState": "VALID", "buildAudienceType": "APP_STORE_ELIGIBLE", "expired": False, "usesNonExemptEncryption": False},
                "relationships": {"app": {"data": {"id": "1234567890"}}, "preReleaseVersion": {"data": {"id": "pre-1"}}}},
                "included": [{"id": "pre-1", "type": "preReleaseVersions", "attributes": {"version": "2.0", "platform": "IOS"}}]}
        if path.startswith("apps/1234567890/appStoreVersions?"):
            return {"data": [{"id": "version-2", "attributes": {"appVersionState": self.state, "versionString": "2.0"}}]}
        if path == "appStoreVersions/version-2/appStoreVersionLocalizations?limit=200":
            return {"data": [{"id": "en", "attributes": {"locale": "en-US"}}]}
        if path.startswith("reviewSubmissions?"): return {"data": []}
        raise AssertionError(path)

class SubmissionTests(unittest.TestCase):
    def test_trims_a_copied_credential_before_building_the_header(self):
        def open_request(request, timeout):
            self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
            return BytesIO(b'{}')
        with patch.object(submission.urllib.request, "urlopen", side_effect=open_request):
            self.assertEqual(submission.request_json("https://example.invalid", "test-token\n"), {})

    def test_rejects_invalid_credentials_without_echoing_them(self):
        with patch.object(submission.urllib.request, "urlopen", side_effect=AssertionError("Unexpected request")):
            with self.assertRaisesRegex(ValueError, "Invalid API credential format") as error:
                submission.request_json("https://example.invalid", "sensitive\nvalue")
            self.assertNotIn("sensitive", str(error.exception))

    def test_uploads_localized_notes_and_promo_and_attaches_exact_build(self):
        apple = Apple()
        self.assertEqual(submission.submit_release(apple, JOB, MANIFEST, METADATA), "submitted")
        localized = next(body for path, method, body in apple.writes if path == "appStoreVersionLocalizations/en")
        self.assertEqual(localized["data"]["attributes"]["whatsNew"], "Improved performance.")
        self.assertEqual(localized["data"]["attributes"]["promotionalText"], "Explore the latest improvements.")
        attached = next(body for path, method, body in apple.writes if path == "appStoreVersions/version-2")
        self.assertEqual(attached["data"]["relationships"]["build"]["data"]["id"], "build-123")
        self.assertEqual(attached["data"]["attributes"]["releaseType"], "MANUAL")
        self.assertEqual(apple.writes[-1], ("reviewSubmissions/review-1", "PATCH",
            {"data": {"type": "reviewSubmissions", "id": "review-1", "attributes": {"submitted": True}}}))

    def test_current_version_in_review_is_left_alone(self):
        apple = Apple("WAITING_FOR_REVIEW")
        self.assertEqual(submission.submit_release(apple, JOB, MANIFEST, METADATA), "skipped")
        self.assertEqual(apple.writes, [])

    def test_dry_run_does_not_mutate_apple(self):
        apple = Apple()
        self.assertEqual(submission.submit_release(apple, JOB, MANIFEST, METADATA, dry_run=True), "validated")
        self.assertEqual(apple.writes, [])

    def test_wrong_release_version_is_rejected_before_writes(self):
        apple = Apple()
        with self.assertRaisesRegex(ValueError, "manifest version"):
            submission.submit_release(apple, JOB, dict(MANIFEST, version="3.0"), METADATA)
        self.assertEqual(apple.writes, [])

    def test_overlong_promotional_text_is_rejected_before_writes(self):
        apple = Apple()
        with self.assertRaisesRegex(ValueError, "promotionalText"):
            submission.submit_release(apple, JOB, MANIFEST, {"en-US": dict(METADATA["en-US"], promotionalText="x" * 171)})
        self.assertEqual(apple.writes, [])

    def test_disabled_manifest_skips_release(self):
        apple = Apple()
        self.assertEqual(submission.submit_release(apple, JOB, dict(MANIFEST, enabled=False), METADATA), "skipped")
        self.assertEqual(apple.writes, [])

    def test_reads_metadata_from_the_build_commit_instead_of_working_tree(self):
        with tempfile.TemporaryDirectory(prefix="example-release-test-") as temp:
            root = Path(temp)
            def git(*args):
                return subprocess.check_output(["git", "-C", temp, *args], stderr=subprocess.DEVNULL).decode().strip()
            git("init", "-q")
            folder = root / "ios/fastlane/metadata/en-US"
            folder.mkdir(parents=True)
            (root / "ios/fastlane/release.json").write_text(json.dumps(MANIFEST))
            for filename, field in submission.FILES.items():
                (folder / filename).write_text(METADATA["en-US"][field])
            git("add", ".")
            git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-qm", "Release metadata")
            sha = git("rev-parse", "HEAD")
            (folder / "release_notes.txt").write_text("Uncommitted notes for a different release")
            manifest, metadata = submission.load_release(root, sha)
            self.assertEqual(metadata["en-US"]["whatsNew"], "Improved performance.")
            self.assertEqual(manifest["version"], "2.0")

if __name__ == "__main__": unittest.main()
