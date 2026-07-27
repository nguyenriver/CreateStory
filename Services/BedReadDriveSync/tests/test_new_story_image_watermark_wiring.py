from __future__ import annotations

import pytest

from api.services.drive_service import _drive_api as drive_api_module
from api.services.drive_service._watermark_processing import WatermarkProcessingResult
from api.services.drive_service.drive_service import DriveSyncService


class _DrivePlaceholder:
    pass


@pytest.mark.parametrize(
    ("asset_type", "method_name", "finder_name", "uploader_name", "filename", "url_key"),
    [
        (
            "banner",
            "upload_banner_for_new_story",
            "_find_banner1_file",
            "_upload_banner_image",
            "banner.png",
            "banner_url",
        ),
        (
            "intro",
            "upload_intro_for_new_story",
            "_find_intro1_file",
            "_upload_intro_image",
            "intro.jpg",
            "intro_url",
        ),
    ],
)
def test_new_story_images_are_cleaned_between_drive_download_and_upload(
    monkeypatch,
    asset_type: str,
    method_name: str,
    finder_name: str,
    uploader_name: str,
    filename: str,
    url_key: str,
) -> None:
    service = DriveSyncService.__new__(DriveSyncService)
    service._build_drive_service = lambda: _DrivePlaceholder()
    setattr(
        service,
        finder_name,
        lambda _drive, _folder_id, candidate: {"id": "drive-image", "name": filename}
        if candidate == filename
        else None,
    )
    monkeypatch.setattr(
        drive_api_module.DriveAPIMixin,
        "_download_cover_image_bytes",
        lambda *_args: b"ORIGINAL-IMAGE",
    )

    processing_calls: list[tuple[bytes, str, str]] = []

    def process(image_bytes: bytes, image_filename: str, image_asset_type: str):
        processing_calls.append((image_bytes, image_filename, image_asset_type))
        return WatermarkProcessingResult(
            image_bytes=b"CLEANED-IMAGE",
            applied=True,
            applied_passes=2,
            processing_ms=25,
            stop_reason="no-match",
        )

    service._process_watermarks_for_upload = process
    service._log_watermark_processing_result = lambda *_args: None
    uploaded: list[bytes] = []

    def upload(_story_id: str, image_bytes: bytes, _filename: str, _content_type: str):
        uploaded.append(image_bytes)
        return f"https://main.example.com/{filename}", None

    setattr(service, uploader_name, upload)

    result = getattr(service, method_name)("story-id", "folder-id", job_id="job-id")

    assert result["uploaded"] is True
    assert result[url_key] == f"https://main.example.com/{filename}"
    assert processing_calls == [(b"ORIGINAL-IMAGE", filename, asset_type)]
    assert uploaded == [b"CLEANED-IMAGE"]


@pytest.mark.parametrize(
    ("method_name", "finder_name", "uploader_name", "filename"),
    [
        ("upload_banner_for_new_story", "_find_banner1_file", "_upload_banner_image", "banner.png"),
        ("upload_intro_for_new_story", "_find_intro1_file", "_upload_intro_image", "intro.jpg"),
    ],
)
def test_new_story_secondary_images_skip_cleanup_when_toggle_is_off(
    monkeypatch,
    method_name: str,
    finder_name: str,
    uploader_name: str,
    filename: str,
) -> None:
    service = DriveSyncService.__new__(DriveSyncService)
    service._build_drive_service = lambda: _DrivePlaceholder()
    setattr(
        service,
        finder_name,
        lambda _drive, _folder_id, candidate: {"id": "drive-image", "name": filename}
        if candidate == filename
        else None,
    )
    monkeypatch.setattr(
        drive_api_module.DriveAPIMixin,
        "_download_cover_image_bytes",
        lambda *_args: b"ORIGINAL-IMAGE",
    )
    service._process_watermarks_for_upload = lambda *_args: pytest.fail(
        "The watermark processor must not run when the upload toggle is off."
    )
    uploaded: list[bytes] = []

    def upload(_story_id: str, image_bytes: bytes, _filename: str, _content_type: str):
        uploaded.append(image_bytes)
        return f"https://main.example.com/{filename}", None

    setattr(service, uploader_name, upload)

    result = getattr(service, method_name)(
        "story-id",
        "folder-id",
        job_id="job-id",
        process_watermark=False,
    )

    assert result["uploaded"] is True
    assert uploaded == [b"ORIGINAL-IMAGE"]


def test_cover_is_cleaned_between_drive_download_and_upload() -> None:
    service = DriveSyncService.__new__(DriveSyncService)
    service._extract_story_name = lambda _name: "Existing Story"
    service._find_synopsis_file = lambda *_args: None
    service._parse_tags_file = lambda *_args: []
    service._parse_category_file = lambda *_args: (None, [])
    service._extract_reference_platform = lambda *_args: None
    service._find_push_file = lambda *_args: None
    service._find_free_md_file = lambda *_args: None
    service._parse_length_file = lambda *_args, **_kwargs: None
    service._find_story_by_title = lambda *_args: "story-id"
    service._find_cover_image_file = lambda *_args: {"id": "cover-file", "name": "cover.jpg"}
    service._download_cover_image_bytes = lambda *_args: b"ORIGINAL-COVER"
    service._get_existing_chapter_indices = lambda *_args: set()
    service._find_chapters_extended_folder = lambda *_args: None
    service._list_files_in_folder = lambda *_args: []
    service._parse_max_chapter_file = lambda *_args, **_kwargs: None
    service.append_job_log = lambda *_args: None
    service._log_watermark_processing_result = lambda *_args: None
    processing_calls: list[tuple[bytes, str, str]] = []

    def process(image_bytes: bytes, filename: str, asset_type: str):
        processing_calls.append((image_bytes, filename, asset_type))
        return WatermarkProcessingResult(
            image_bytes=b"CLEANED-COVER",
            applied=True,
            applied_passes=2,
            processing_ms=25,
            stop_reason="no-match",
        )

    service._process_watermarks_for_upload = process
    uploaded: list[bytes] = []

    def upload(_story_id: str, image_bytes: bytes, _filename: str):
        uploaded.append(image_bytes)
        return "https://main.example.com/cover.jpg", None

    service._upload_cover_image = upload

    result = service._process_story_folder_with_job(
        _DrivePlaceholder(),
        {"id": "folder-id", "name": "DONE_nw - Existing Story"},
        "job-id",
    )

    assert result == (0, 0, True, "")
    assert processing_calls == [(b"ORIGINAL-COVER", "cover.jpg", "cover")]
    assert uploaded == [b"CLEANED-COVER"]


@pytest.mark.parametrize(
    ("asset_type", "method_name", "finder_name", "uploader_name", "filename"),
    [
        (
            "cover",
            "_upload_story_cover_from_folder",
            "_find_cover1_file",
            "_upload_cover_image",
            "cover1.jpg",
        ),
        (
            "banner",
            "_upload_story_banner_from_folder",
            "_find_banner1_file",
            "_upload_banner_image",
            "banner1.png",
        ),
        (
            "intro",
            "_upload_story_intro_from_folder",
            "_find_intro1_file",
            "_upload_intro_image",
            "intro1.jpg",
        ),
    ],
)
def test_dedicated_image_updates_clean_drive_bytes_before_upload(
    monkeypatch,
    asset_type: str,
    method_name: str,
    finder_name: str,
    uploader_name: str,
    filename: str,
) -> None:
    service = DriveSyncService.__new__(DriveSyncService)
    service._build_drive_service = lambda: _DrivePlaceholder()
    setattr(
        service,
        finder_name,
        lambda _drive, _folder_id, _candidate: {"id": "drive-image", "name": filename},
    )
    monkeypatch.setattr(
        drive_api_module.DriveAPIMixin,
        "_download_cover_image_bytes",
        lambda *_args: b"ORIGINAL-UPDATE-IMAGE",
    )

    processing_calls: list[tuple[bytes, str, str]] = []

    def process(image_bytes: bytes, image_filename: str, image_asset_type: str):
        processing_calls.append((image_bytes, image_filename, image_asset_type))
        return WatermarkProcessingResult(
            image_bytes=b"CLEANED-UPDATE-IMAGE",
            applied=True,
            applied_passes=1,
            processing_ms=20,
            stop_reason="completed",
        )

    service._process_watermarks_for_upload = process
    log_calls: list[tuple[WatermarkProcessingResult, str, str, str | None]] = []
    service._log_watermark_processing_result = (
        lambda result, logged_asset_type, logged_filename, job_id=None:
        log_calls.append((result, logged_asset_type, logged_filename, job_id))
    )
    uploaded: list[tuple[str, bytes, str, str]] = []

    def upload(story_id: str, image_bytes: bytes, image_filename: str, content_type: str):
        uploaded.append((story_id, image_bytes, image_filename, content_type))
        return f"https://main.example.com/{filename}", None

    setattr(service, uploader_name, upload)

    success, result = getattr(service, method_name)(
        "story-id",
        "folder-id",
        filename,
        job_id="update-job-id",
        process_watermark=True,
    )

    assert success is True
    assert result == f"https://main.example.com/{filename}"
    assert processing_calls == [(b"ORIGINAL-UPDATE-IMAGE", filename, asset_type)]
    assert uploaded[0][0:3] == ("story-id", b"CLEANED-UPDATE-IMAGE", filename)
    assert len(log_calls) == 1
    assert log_calls[0][1:] == (asset_type, filename, "update-job-id")


def test_dedicated_image_update_skips_cleanup_when_toggle_is_off(monkeypatch) -> None:
    service = DriveSyncService.__new__(DriveSyncService)
    service._build_drive_service = lambda: _DrivePlaceholder()
    service._find_cover1_file = lambda *_args: {"id": "drive-cover", "name": "cover1.jpg"}
    monkeypatch.setattr(
        drive_api_module.DriveAPIMixin,
        "_download_cover_image_bytes",
        lambda *_args: b"ORIGINAL-COVER",
    )
    service._process_watermarks_for_upload = lambda *_args: pytest.fail(
        "The watermark processor must not run when the toggle is off."
    )
    logs: list[tuple[str, str, str]] = []
    service.append_job_log = lambda job_id, level, message: logs.append((job_id, level, message))
    uploaded: list[bytes] = []
    service._upload_cover_image = (
        lambda _story_id, image_bytes, _filename, _content_type:
        uploaded.append(image_bytes) or ("https://main.example.com/cover1.jpg", None)
    )

    success, _result = service._upload_story_cover_from_folder(
        "story-id",
        "folder-id",
        "cover1.jpg",
        job_id="update-job-id",
        process_watermark=False,
    )

    assert success is True
    assert uploaded == [b"ORIGINAL-COVER"]
    assert logs == [
        ("update-job-id", "info", "Cover watermark cleanup disabled; uploading original bytes.")
    ]
