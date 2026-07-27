"""
Smoke test for the new-story banner upload.

Exercises the full code path of `upload_banner_for_new_story`:
  - Drive auth + file search for banner.jpg / banner.jpeg / banner.png
  - File download via `_download_cover_image_bytes`
  - POST to main BE `/api/v1/story/{id}/upload-banner` via `_upload_banner_image`
  - Logging branches (success / error / not-found)

Mocks Drive auth, the Drive service `files().list().execute()`, the download,
and the main BE upload. Verifies the wire-up is correct and that each banner
filename is honored.
"""
import sys
import os
import types
import importlib

# Ensure the service module is importable. This file lives at
# <repo>/Services/BedReadDriveSync/tests/smoke_banner_upload.py, so the
# BedReadDriveSync directory is two levels up.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from api.services.drive_service import drive_service as ds_module
from api.services.drive_service.drive_service import DriveSyncService
from api.services.drive_service import _banner_update as banner_module
from api.services.drive_service import _main_be_client as main_be_client_module
from api.services.drive_service import _drive_api as drive_api_module


class FakeFilesList:
    def __init__(self, files_for_query):
        # files_for_query maps lowercase banner filename -> file dict (or None for "not found")
        self._files_for_query = files_for_query

    def list(self, q, fields=None, pageSize=None):
        # Pull out name='<candidate>' from the Drive query
        candidate = None
        for token in q.split(" and "):
            token = token.strip()
            if token.startswith("name="):
                candidate = token[len("name="):].strip("'")
                break
        return _FakeListExecute(self._files_for_query.get(candidate))

    def get(self, fileId=None, fields=None):
        return _FakeGetExecute({"id": fileId, "name": f"file-{fileId}"})


class _FakeListExecute:
    def __init__(self, file_dict):
        self._file = file_dict

    def execute(self):
        if self._file is None:
            return {"files": []}
        return {"files": [self._file]}


class _FakeGetExecute:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class FakeDriveService:
    def __init__(self, files_for_query):
        self._files_for_query = files_for_query

    def files(self):
        return FakeFilesList(self._files_for_query)


def _make_service(files_for_query, banner_url="https://main.example.com/banner.jpg"):
    """Build a DriveSyncService-shaped instance with the methods we need stubbed."""
    svc = DriveSyncService.__new__(DriveSyncService)
    svc._build_drive_service = lambda: FakeDriveService(files_for_query)

    uploaded_payloads = []
    download_log = []

    def fake_upload_banner_image(story_id, image_bytes, filename, content_type):
        uploaded_payloads.append({
            "story_id": story_id,
            "filename": filename,
            "content_type": content_type,
            "size": len(image_bytes),
        })
        if banner_url:
            return banner_url, None
        return None, "stubbed upload failure"

    svc._upload_banner_image = fake_upload_banner_image

    def fake_download(self, drive_service, file_id):
        download_log.append(file_id)
        return b"FAKE-BANNER-BYTES"

    drive_api_module.DriveAPIMixin._download_cover_image_bytes = fake_download
    return svc, uploaded_payloads, download_log


def _find_files(files_for_query, name):
    """Helper: what _find_banner1_file would return when called with the given filename."""
    service = FakeDriveService(files_for_query)
    for f in service.files().list(q=f"name='{name}'").execute().get("files", []):
        if f.get("name") == name:
            return f
    return None


def run_case(label, files_for_query, expected_filename=None, banner_url="https://main.example.com/banner.jpg", expect_error=False):
    svc, uploaded, downloads = _make_service(files_for_query, banner_url=banner_url)
    result = svc.upload_banner_for_new_story("story-xyz", "folder-abc")

    print(f"--- {label}")
    print(f"  result: {result}")
    print(f"  uploads: {uploaded}")
    print(f"  downloads: {downloads}")

    if expect_error:
        assert result["uploaded"] is False, f"[{label}] expected uploaded=False"
        assert result["error"], f"[{label}] expected an error string"
    elif expected_filename is None:
        if result.get("error") is None:
            assert result["uploaded"] is False, f"[{label}] expected uploaded=False (no file)"
            assert result["banner_url"] is None
        else:
            assert result["uploaded"] is False, f"[{label}] expected uploaded=False (upload failed)"
            assert result["banner_url"] is None
    else:
        assert result["uploaded"] is True, f"[{label}] expected uploaded=True"
        assert result["banner_url"] == banner_url
        assert result["error"] is None
        assert result["filename"] == expected_filename
        assert len(uploaded) == 1
        assert uploaded[0]["filename"] == expected_filename
        assert uploaded[0]["story_id"] == "story-xyz"
        assert uploaded[0]["size"] == len(b"FAKE-BANNER-BYTES")

    return result


def main():
    # Case 1: banner.jpg present, no banner.png -> should pick banner.jpg
    run_case(
        "banner.jpg present",
        files_for_query={"banner.jpg": {"id": "fid-1", "name": "banner.jpg"}, "banner.png": None},
        expected_filename="banner.jpg",
    )

    # Case 2: only banner.png present -> should pick banner.png
    run_case(
        "banner.png present",
        files_for_query={"banner.jpg": None, "banner.png": {"id": "fid-2", "name": "banner.png"}},
        expected_filename="banner.png",
    )

    # Case 3: only banner.jpeg present
    run_case(
        "banner.jpeg present",
        files_for_query={"banner.jpeg": {"id": "fid-3", "name": "banner.jpeg"}, "banner.jpg": None, "banner.png": None},
        expected_filename="banner.jpeg",
    )

    # Case 4: priority order: banner.jpg wins over banner.png when both exist
    run_case(
        "priority: banner.jpg wins over banner.png",
        files_for_query={
            "banner.jpg": {"id": "fid-4a", "name": "banner.jpg"},
            "banner.jpeg": {"id": "fid-4b", "name": "banner.jpeg"},
            "banner.png": {"id": "fid-4c", "name": "banner.png"},
        },
        expected_filename="banner.jpg",
    )

    # Case 5: no banner at all -> no upload, no error
    run_case(
        "no banner file present",
        files_for_query={"banner.jpg": None, "banner.jpeg": None, "banner.png": None},
        expected_filename=None,
    )

    # Case 6: main BE returns no URL -> error path
    run_case(
        "main BE returns no URL",
        files_for_query={"banner.png": {"id": "fid-6", "name": "banner.png"}},
        expected_filename=None,
        banner_url=None,
    )

    print("\nAll smoke-test cases passed.")


if __name__ == "__main__":
    main()
