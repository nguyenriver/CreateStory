"""Path constants and shared module-level constants for the drive_service package.

This module intentionally has NO imports from sibling modules (no circular dependency risk).
All constants that need to be shared across _config_store, _drive_api, _parsers,
_history_jobs, and drive_service live here.
"""

import os
import re
import threading

# -------------------------------------------------------------------------
# Regex patterns (used by _parsers, _history_jobs, drive_service)
# -------------------------------------------------------------------------
_RE_STATUS_PREFIX = re.compile(r"^(DONE_|ING_|INCOMPLETE_|EXTENDED_)")

_RE_SOURCE_SUFFIX = re.compile(
    r"_(?:wp|gd|Goodnovel|nw|ink|jn|jobnib|sh|scribblehub|nl|novellunar|wn|webnovel|nh|novelhall)(?![a-zA-Z0-9_])|_-_?novel(?=\s|_|\s-\s|$)", re.IGNORECASE
)

# -------------------------------------------------------------------------
# Category / platform maps (used by _parsers, drive_service)
# -------------------------------------------------------------------------
_PLATFORM_TO_ENUM: dict[str, str] = {
    "wp": "Wattpad",
    "wattpad": "Wattpad",
    "gd": "Goodnovel",
    "goodnovel": "Goodnovel",
    "nw": "NovelWorm",
    "novelworm": "NovelWorm",
    "ink": "Inkitt",
    "inkitt": "Inkitt",
    "jn": "Jobnib",
    "jobnib": "Jobnib",
    "sh": "ScribbleHub",
    "scribblehub": "ScribbleHub",
    "nl": "NovelLunar",
    "novellunar": "NovelLunar",
    "wn": "WebNovel",
    "webnovel": "WebNovel",
    "nh": "NovelHall",
    "novelhall": "NovelHall",
}

_CATEGORY_MAP: dict[str, tuple[str, str | None]] = {
    "fantasy": ("154971fe-7da7-41c4-91ee-b2a9613d6fa0", None),
    "werewolf": ("2d2614d9-2b25-4d1f-bb0a-fb333193de19", None),
    "romance": ("17c9779b-7107-4b24-a020-df735e1dd6cb", None),
    "billionaire": ("1550cd02-d20b-4fc3-9dce-6c8c5ccaba11", None),
    "billionair": ("1550cd02-d20b-4fc3-9dce-6c8c5ccaba11", None),
    "billionaireromance": (
        "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
        "17c9779b-7107-4b24-a020-df735e1dd6cb",
    ),
    "billionairromance": (
        "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
        "17c9779b-7107-4b24-a020-df735e1dd6cb",
    ),
    "billionairelgbtq": (
        "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
        "8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf",
    ),
    "billionairelgbt": (
        "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
        "8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf",
    ),
    "billionairlgbtq": (
        "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
        "8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf",
    ),
    "billionairlgbt": (
        "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
        "8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf",
    ),
    "lgbtq": ("8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf", None),
    "lgbt": ("8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf", None),
    "lgbtq+": ("8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf", None),
}

# -------------------------------------------------------------------------
# Job / history limits
# -------------------------------------------------------------------------
_MAX_HISTORY_ENTRIES = 200
_MAX_JOBS_ENTRIES = 2000

_RANDOM_AUTHOR_IDS = [
    "0a00de42-0bde-4457-8f78-e91ecc64b066",
    "10e57755-f3fe-4e47-8f63-899124775a78",
    "1cdd39cc-50ae-4ba2-8942-426ca1a6bc51",
    "1d7336e0-d78f-400c-bc78-4aae9321824a",
    "2c49b76d-ff56-4f92-bf61-3054da1c2e26",
    "3487b310-22ef-4b0d-8dcf-2cf98ac1ace4",
    "433976e0-2b57-45b7-bde9-18d68fbf2837",
    "4ef14491-77f6-4502-a85a-211372e4cb98",
    "6078dc6e-ad32-425c-89eb-8a5cfd6a9f40",
    "61e0fd34-c99e-4f2b-9a3f-d3a78ca3ffc0",
    "71593725-13cb-493b-8b95-8e8367dd0b11",
    "7239c50e-64d2-4996-b20d-a915dd653bbe",
    "85ae7bda-3366-4d16-a5a6-737738291363",
    "9d183206-1be9-4662-a69b-51ed09bf2933",
    "ab5204f4-1562-499b-bf7b-64d8ab23b7b1",
    "ab877079-a188-44d8-af6f-2055742b2fa9",
    "d3a4effb-7b5a-490a-9616-12a8524fa9a8",
    "d757060a-3a79-428c-8ab5-beeceec3e130",
    "df79558c-f2e8-4597-8aa8-cacd0d8bfff8",
]

# -------------------------------------------------------------------------
# Drive API call settings (used by _drive_api, drive_service)
# -------------------------------------------------------------------------
def _positive_int_from_env(name: str, default: int) -> int:
    try:
        raw = os.getenv(name)
        return max(1, int(raw)) if raw is not None else default
    except (TypeError, ValueError):
        return default


_DRIVE_CALL_RETRIES = 5
_DRIVE_CALL_BACKOFF_BASE = 0.5
_DRIVE_CALL_CONCURRENCY = _positive_int_from_env("DRIVE_SYNC_DRIVE_CONCURRENCY", 6)
_CHAPTER_PREFETCH_WORKERS = _positive_int_from_env("DRIVE_SYNC_CHAPTER_PREFETCH_WORKERS", 4)
_CHAPTER_WINDOW_SIZE = _positive_int_from_env("DRIVE_SYNC_CHAPTER_WINDOW_SIZE", 8)
_CHECK_BATCH_CHUNK_SIZE = _positive_int_from_env("DRIVE_SYNC_CHECK_BATCH_CHUNK_SIZE", 25)
_CHECK_BATCH_PAGE_SIZE = _positive_int_from_env("DRIVE_SYNC_CHECK_BATCH_PAGE_SIZE", 1000)
_MAIN_BE_MAX_KEEPALIVE_CONNECTIONS = _positive_int_from_env("DRIVE_SYNC_MAIN_BE_KEEPALIVE_CONNECTIONS", 20)
_MAIN_BE_MAX_CONNECTIONS = _positive_int_from_env("DRIVE_SYNC_MAIN_BE_MAX_CONNECTIONS", 40)
_DRIVE_CALL_SEMAPHORE = threading.BoundedSemaphore(_DRIVE_CALL_CONCURRENCY)
# Max parent IDs per Drive `parents in (...)` query clause. The Drive `q`
# parameter has a 2048-character limit. With 60-char parent IDs, ~25 fits
# safely with the rest of the query clause.
_DRIVE_QUERY_BATCH_SIZE = _positive_int_from_env("DRIVE_SYNC_QUERY_BATCH_SIZE", 25)

# TTL for in-memory caches (seconds)
_SUBFOLDER_CACHE_TTL = 900      # 15 min — title → chapters-extended subfolder-id
_MD_FILES_CACHE_TTL = 600       # 10 min — subfolder-id → .md file list

# -------------------------------------------------------------------------
# Misc
# -------------------------------------------------------------------------
_ACTION_KINDS = {
    "upload_single",
    "upload_batch",
    "update_single",
    "update_batch",
    "test_sync",
    "config_save",
}
_ACTION_STATUSES = {"running", "success", "error", "cancelled"}
_SYSTEM_FOLDERS = {".tmp", ".workdir", ".cowork-trash"}


def _natural_sort_key(path: str) -> tuple[int | str, ...]:
    """Sort chapter files naturally by extracting numeric indices."""
    stem = Path(path).stem
    numbers = re.findall(r"\d+", stem)
    if numbers:
        return (int(numbers[0]), stem)
    return (0, stem)
