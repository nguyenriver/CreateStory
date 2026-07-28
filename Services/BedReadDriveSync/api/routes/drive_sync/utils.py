"""Shared utilities and models for drive sync routes."""

from pydantic import BaseModel
from typing import Optional, Tuple


def _is_valid_upload_format(folder_name: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Correct format: PREFIX_{...}_{platform} - {title}
    Valid platforms include wp, gd, Goodnovel, nw, ink, jn, wn, nh, and rn (case-insensitive).
    Returns (is_valid, raw_token, recognized_source) where:
      - raw_token is the token found between prefix '_' and ' - ', or None
      - recognized_source is the normalized source name if recognized, or None
    """
    dash_pos = folder_name.find(" - ")
    if dash_pos == -1:
        return False, None, None

    prefix_end = folder_name.find("_")
    if prefix_end == -1 or dash_pos <= prefix_end:
        return False, None, None

    between_prefix_and_dash = folder_name[prefix_end:dash_pos]

    # The source token is the last _segment (e.g. _max from _Something_max)
    segments = between_prefix_and_dash.split("_")
    last_segment = segments[-1].strip() if segments else ""
    raw_token = last_segment if last_segment else None

    # Check if the raw token is a recognized source
    if raw_token:
        token_lower = raw_token.lower()
        if token_lower == "gd":
            return True, "gd", "Goodnovel"
        if token_lower == "nw":
            return True, "nw", "NovelWorm"
        if token_lower in ("wp", "wattpad"):
            return True, "wp", "Wattpad"
        if token_lower in ("ink", "inkitt"):
            return True, "ink", "Inkitt"
        if token_lower in ("jn", "jobnib"):
            return True, "jn", "Jobnib"
        if token_lower in ("wn", "webnovel"):
            return True, "wn", "WebNovel"
        if token_lower in ("nh", "novelhall"):
            return True, "nh", "NovelHall"
        if token_lower in ("goodnovel", "novelworm"):
            return True, token_lower, token_lower.capitalize()
        # Not recognized
        return False, raw_token, None

    return False, None, None


class DriveChapterPreview(BaseModel):
    file_name: str
    index: int
    title: str
    content_preview: str
    content_length: int
    download_error: bool


class DriveStoryPreview(BaseModel):
    folder_id: str
    folder_name: str
    prefix: str
    display_name: str
    is_completed: bool
    chapter_count: int
    modified_time: Optional[str] = None
    chapters: list[DriveChapterPreview]


class DriveFolderEntry(BaseModel):
    id: str
    name: str
    prefix: str
    display_name: str
    is_completed: bool
    is_valid_format: bool = True
    has_chapter_duplicates: bool = False
    validation_errors: list[str] = []
    chapter_count: Optional[int] = None
    extended_chapter_count: Optional[int] = None
    modified_time: Optional[str] = None


class DriveFolderListResponse(BaseModel):
    folders: list[DriveFolderEntry]
    total: int
    limit: int
    offset: int


class ServerStoryRef(BaseModel):
    id: str
    title: str
    maxChapter: int


class CheckUploadableResponse(BaseModel):
    drive_folders: list[DriveFolderEntry]
    server_stories: list[ServerStoryRef]
    uploadable: list[DriveFolderEntry]
    already_on_server: list[DriveFolderEntry]
    invalid: list[DriveFolderEntry] = []
    not_ready: list[DriveFolderEntry] = []


class UpdatableStoryEntry(BaseModel):
    folder: DriveFolderEntry
    server_story: ServerStoryRef
    new_chapters_count: int = 0
    free_chapters_count: Optional[int] = None
    tags: Optional[list[str]] = None
    has_free_md: bool = False
    has_tags_md: bool = False
    last_updated: Optional[str] = None


class ServerOnlyStoryEntry(BaseModel):
    server_story: ServerStoryRef
    last_updated: Optional[str] = None


class CheckUpdatableResponse(BaseModel):
    all_extended_folders: list
    server_stories: list[ServerStoryRef]
    updatable: list[UpdatableStoryEntry]
    no_update_needed: list[UpdatableStoryEntry]
    no_server_match: list[DriveFolderEntry] = []
    empty_extended: list[DriveFolderEntry] = []
    invalid: list[UpdatableStoryEntry] = []
    no_drive_folder: list[ServerOnlyStoryEntry] = []
