"""Site detection and chapter listing routes."""

import logging
import re
import threading
import time
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup
from fastapi import APIRouter, Query

from api.models.site_info import (
    BinarySearchTotalResponse,
    ChapterEntry,
    ChapterListResponse,
    SiteDetectResponse,
    SiteInfoResponse,
)
from api.services.site_service import get_site_service
from utils.proxy import requests_proxies

router = APIRouter(prefix="/api/sites", tags=["Sites"])

logger = logging.getLogger(__name__)

# In-memory cache for binary search results keyed by story URL.
# Value: {"total": int, "fetched_at": float, "done": bool}
_binary_search_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()

_INKITT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/136.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.inkitt.com/",
}


def is_novelworm_chapter_url(url: str) -> bool:
    return bool(re.search(r"/\d{3,}/?$", url.rstrip("/")))


def is_jobnib_chapter_url(url: str) -> bool:
    parsed_path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    return bool(re.search(r"/book/[^/]+-chapter-\d+(?:-\d+)?$", parsed_path))


def is_scribblehub_chapter_url(url: str) -> bool:
    parsed_path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    return bool(re.search(r"/read/\d+-[^/]+/chapter/\d+$", parsed_path))


def is_novellunar_chapter_url(url: str) -> bool:
    parsed_path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    return bool(re.search(r"/novel/[^/]+/chapter/\d+$", parsed_path))


def is_goodnovel_chapter_url(url: str) -> bool:
    # Book: /book/<slug>_<bookId>   Chapter: /book/<slug>_<bookId>/Chapter-NNNN_<chapterId>
    parsed_path = urllib.parse.urlparse(url).path.rstrip("/")
    return bool(re.search(r"/book/[^/]+_\d+/[^/]+_\d+$", parsed_path, re.IGNORECASE))


def is_webnovel_chapter_url(url: str) -> bool:
    parsed_path = urllib.parse.urlparse(url).path.rstrip("/")
    return bool(re.search(r"/book/[^/]+_\d+/[^/]+_\d+$", parsed_path, re.IGNORECASE))


def is_novelhall_chapter_url(url: str) -> bool:
    # Story: /<slug>-<id>/   Chapter: /<slug>-<id>/<chapterId>.html
    parsed_path = urllib.parse.urlparse(url).path
    return bool(re.search(r"/[^/]+-\d+/\d+\.html$", parsed_path, re.IGNORECASE))


def is_chapter_url(url: str) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url.strip("/"))
    path = parsed.path.lower()

    if "wattpad" in parsed.netloc:
        chapter_match = re.search(r"/\d+/chapter-\d+", path)
        if chapter_match:
            return True
        return False

    if "novelworm" in parsed.netloc:
        return is_novelworm_chapter_url(url)

    if "jobnib" in parsed.netloc:
        return is_jobnib_chapter_url(url)

    if "scribblehub" in parsed.netloc:
        return is_scribblehub_chapter_url(url)

    if "novellunar" in parsed.netloc:
        return is_novellunar_chapter_url(url)

    if "goodnovel" in parsed.netloc:
        return is_goodnovel_chapter_url(url)

    if "webnovel" in parsed.netloc:
        return is_webnovel_chapter_url(url)

    if "novelhall" in parsed.netloc:
        return is_novelhall_chapter_url(url)

    return False


def _fetch_novelworm_chapters(story_url: str, timeout: int = 30) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str]]:
    try:
        from api.services.novelworm_api import NovelWormApiClient

        client = NovelWormApiClient(timeout=timeout)
        story = client.resolve_story(story_url)
    except Exception as exc:
        logger.warning("[novelworm] API chapter list failed for story page: %s", exc)
        return [], "NovelWorm API request failed.", None, None

    entries = [
        ChapterEntry(chapter_number=ref.chapter_number, title=ref.title, url=ref.url)
        for ref in story.chapters[:50]
    ]
    return entries, None, len(story.chapters), story.title


def _start_binary_search_background(browser, story_url: str) -> None:
    """Spawn a daemon thread to run binary search and cache the result."""
    url_key = story_url.rstrip("/")

    with _cache_lock:
        # Skip if already cached (with fresh TTL of 1 hour)
        entry = _binary_search_cache.get(url_key)
        if entry and entry["done"] and (time.time() - entry["fetched_at"]) < 3600:
            return
        # Mark as in-progress (idempotent — safe to call twice)
        _binary_search_cache[url_key] = {
            "total": None,
            "done": False,
            "fetched_at": time.time(),
        }

    def _run():
        total = _novelworm_binary_search_total(browser, story_url)
        with _cache_lock:
            _binary_search_cache[url_key] = {
                "total": total,
                "done": True,
                "fetched_at": time.time(),
            }
        logger.info("[novelworm] Binary search background done: %d chapters for %s", total, story_url)

    t = threading.Thread(target=_run, daemon=True)
    t.start()


def _novelworm_binary_search_total(browser, story_url: str, max_guess: int = 5000) -> int:
    """Run binary search to find the highest valid chapter number for a NovelWorm story."""
    def fetch_title(url: str) -> bool:
        try:
            _, _, body, _, _ = browser.fetch(url, timeout=10, skip_scroll=True)
            html = body.decode("utf-8", errors="replace")
            return _extract_chapter_title_from_html(html) != ""
        except Exception:
            return False

    def extract_chapter_num(url: str) -> int | None:
        m = re.search(r"/(\d+)/?$", url.rstrip("/"))
        return int(m.group(1)) if m else None

    low, high = 1, max_guess
    best = 0

    while low <= high:
        mid = (low + high) // 2
        url = f"{story_url.rstrip('/')}/{str(mid).zfill(6)}"
        if fetch_title(url):
            best = mid
            low = mid + 1
        else:
            high = mid - 1

    # Refine around the boundary in chunks of 10, then 100
    for delta in [10, 100]:
        check_url = f"{story_url.rstrip('/')}/{str(best + delta).zfill(6)}"
        if fetch_title(check_url):
            low, high = best + 1, best + delta * 2
            while low <= high:
                mid = (low + high) // 2
                url = f"{story_url.rstrip('/')}/{str(mid).zfill(6)}"
                if fetch_title(url):
                    best = mid
                    low = mid + 1
                else:
                    high = mid - 1
            break

    return best


def _extract_chapter_title_from_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    og = soup.select_one("meta[property='og:title']")
    if og:
        content = og.get("content", "").strip()
        if content:
            return content
    selectors = [
        "h1.chapter-title", ".chapter-header h1", ".chapter-title",
        "[class*='chapter-title']", "h1",
    ]
    for sel in selectors:
        el = soup.select_one(sel)
        if el:
            text = el.get_text(strip=True)
            if text:
                return text
    return ""


def _extract_novelworm_story_title(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    selectors = [
        ("meta[property='og:title']", "content"),
        ("h1.story-title", None),
        (".story-header h1", None),
        (".story-info h1", None),
        ("[class*='story-title']", None),
        ("h1[class*='title']", None),
    ]
    for sel, attr in selectors:
        el = soup.select_one(sel)
        if el:
            if attr:
                val = el.get(attr, "").strip()
            else:
                val = el.get_text(strip=True)
            if val:
                return val
    return None


def _parse_novelworm_chapters_from_html(html: str, base_url: str) -> tuple[list[ChapterEntry], Optional[str], Optional[int]]:
    soup = BeautifulSoup(html, "html.parser")
    entries: list[ChapterEntry] = []

    container_selectors = [
        ".chapter-list", ".table-of-contents", ".chapters", ".chapter-item",
        "[class*='chapter-list']", "[class*='toc']", "ul.chapters", "ol.chapters",
    ]

    containers = []
    for sel in container_selectors:
        found = soup.select(sel)
        containers.extend(found)

    anchor_sources = containers if containers else [soup]
    seen_urls: set[str] = set()

    for container in anchor_sources:
        for a in container.find_all("a", href=True) if containers else soup.find_all("a", href=True):
            href = a.get("href", "")
            if not href:
                continue

            if not href.startswith("http"):
                href = urllib.parse.urljoin(base_url, href)

            if "novelworm.com" not in href:
                continue

            if href in seen_urls:
                continue
            seen_urls.add(href)

            title = a.get("title") or a.get_text(strip=True) or ""

            chapter_num: Optional[int] = None
            num_match = re.search(r"/(\d{3,})/?$", href.rstrip("/"))
            if num_match:
                chapter_num = int(num_match.group(1))

            if chapter_num is None:
                text_num_match = re.search(r"chapter\s*(\d+)", title, re.IGNORECASE)
                if text_num_match:
                    chapter_num = int(text_num_match.group(1))

            entries.append(ChapterEntry(
                chapter_number=chapter_num or 0,
                title=title,
                url=href,
            ))

    entries.sort(key=lambda x: x.chapter_number)
    total_count = len(entries)
    if not entries:
        return [], "No chapter links found on this story page", None

    return entries[:50], None, total_count


def _fetch_wattpad_chapters(story_url: str, timeout: int = 30) -> tuple[list[ChapterEntry], Optional[str], Optional[int]]:
    story_id = _extract_wattpad_story_id(story_url)
    if not story_id:
        return [], "Could not extract Wattpad story ID from URL", None

    api_url = (
        f"https://www.wattpad.com/api/v3/stories/{story_id}"
        f"?fields=id,title,numParts,parts(id,title,url)"
    )

    try:
        from api.services.wattpad_api import get
        resp = get(api_url, story_id=story_id, timeout=timeout)
        if resp.status_code != 200:
            return [], f"Wattpad API returned HTTP {resp.status_code}", None
    except Exception as exc:
        logger.warning("[wattpad] chapter list fetch failed: %s", exc)
        return [], "Wattpad API request failed.", None

    try:
        data = resp.json()
    except Exception:
        return [], "Failed to parse Wattpad API response", None

    if not isinstance(data, dict):
        return [], "Unexpected Wattpad API response format", None

    total_count: Optional[int] = data.get("numParts")
    parts: list[dict] = data.get("parts") or []

    if not parts:
        return [], None, total_count

    entries: list[ChapterEntry] = []
    for idx, part in enumerate(parts[:50], start=1):
        part_url = part.get("url")
        if not part_url:
            continue
        chapter_url = urllib.parse.urljoin("https://www.wattpad.com", part_url)
        title = part.get("title") or ""
        entries.append(ChapterEntry(chapter_number=idx, title=title, url=chapter_url))

    return entries, None, total_count


def _extract_wattpad_story_id(url: str) -> Optional[str]:
    match = re.search(r"/story/(\d+)", url)
    if match:
        return match.group(1)
    match = re.search(r"wattpad\.com/(\d+)-", url)
    if match:
        return match.group(1)
    return None


def _fetch_inkitt_chapters(story_url: str, timeout: int = 30) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str]]:
    try:
        import requests
        from api.db import SessionLocal
        from api.repositories.inkitt_cookie_repository import InkittCookieRepository

        db = SessionLocal()
        try:
            repo = InkittCookieRepository(db)
            saved_cookies = repo.get_valid()
            user_agent = repo.get_user_agent()
        finally:
            db.close()

        session = requests.Session()
        if user_agent:
            session.headers.update({**_INKITT_HEADERS, "User-Agent": user_agent})
        else:
            session.headers.update(_INKITT_HEADERS)

        proxies = requests_proxies("inkitt")
        if proxies:
            session.proxies.update(proxies)

        for cookie in saved_cookies:
            session.cookies.set(
                cookie.name,
                cookie.value,
                domain=cookie.domain,
                path=cookie.path,
            )

        resp = session.get(story_url, timeout=timeout)
    except Exception as exc:
        logger.warning("[inkitt] chapter list fetch failed: %s", exc)
        return [], "Inkitt request failed.", None, None

    if resp.status_code != 200:
        if resp.status_code == 404:
            return [], "This story was not found (HTTP 404). Please verify that the URL is correct and exists on Inkitt.", None, None
        return [], f"Inkitt returned HTTP {resp.status_code}", None, None

    html = resp.text
    if _is_inkitt_blocked(html):
        return [], "Inkitt returned a Cloudflare challenge. Retry after browser cookies are available.", None, None

    soup = BeautifulSoup(html, "html.parser")
    story_id = _extract_inkitt_story_id(story_url)
    if not story_id:
        return [], "Could not extract Inkitt story ID from URL", None, None

    story_title = _extract_inkitt_story_title(soup)
    entries_by_number: dict[int, ChapterEntry] = {}

    for anchor in soup.select("a[href*='/stories/'][href*='/chapters/']"):
        href = anchor.get("href", "")
        if not href:
            continue

        absolute = urllib.parse.urljoin("https://www.inkitt.com", href)
        match = re.search(r"/stories/(\d+)/chapters/(\d+)", urllib.parse.urlparse(absolute).path)
        if not match or match.group(1) != story_id:
            continue

        chapter_number = int(match.group(2))
        title = _clean_inkitt_chapter_title(anchor.get_text(" ", strip=True), chapter_number)
        existing = entries_by_number.get(chapter_number)
        if existing and existing.title:
            continue
        entries_by_number[chapter_number] = ChapterEntry(
            chapter_number=chapter_number,
            title=title,
            url=absolute,
        )

    current_chapter = _extract_inkitt_chapter_number(story_url) or 1
    if current_chapter not in entries_by_number:
        chapter_title = _extract_inkitt_page_chapter_title(soup) or f"Chapter {current_chapter}"
        entries_by_number[current_chapter] = ChapterEntry(
            chapter_number=current_chapter,
            title=chapter_title,
            url=story_url,
        )

    entries = [entries_by_number[n] for n in sorted(entries_by_number)]
    total_count = len(entries)
    if not entries:
        return [], "No chapter links found on this Inkitt page", None, story_title

    is_subscription = False
    if "globalData.authorPatronTiers" in html:
        match = re.search(r"globalData\.authorPatronTiers\s*=\s*\[(.*?)\];", html)
        if match and match.group(1).strip():
            is_subscription = True
    if not is_subscription and ('id="patron-tiers"' in html or 'class="patron-tiers"' in html or 'patron-tiers' in html):
        if soup.select_one("#patron-tiers"):
            is_subscription = True

    warning = "This story requires an author subscription to read fully." if is_subscription else None
    return entries[:50], warning, total_count, story_title


def _fetch_jobnib_chapters(story_url: str, timeout: int = 60) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str]]:
    try:
        import requests
        from spiders.jobnib import JobnibSpider

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/149.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://jobnib.com/",
        }
        resp = requests.get(
            story_url,
            headers=headers,
            timeout=timeout,
            proxies=requests_proxies("jobnib"),
        )
        resp.raise_for_status()

        spider = JobnibSpider(novel=story_url, limit=50)
        soup = BeautifulSoup(resp.text, "html.parser")
        story_title = spider._extract_story_title(soup)
        links = spider._collect_chapter_links(soup, story_url)
    except Exception as exc:
        logger.warning("[jobnib] Chapter list fetch failed: %s", exc)
        return [], "Jobnib chapter list failed.", None, None

    entries = [
        ChapterEntry(
            chapter_number=int(link["chapter_number"]),
            title=link.get("title") or f"Chapter {link['chapter_number']}",
            url=link["url"],
        )
        for link in links[:50]
    ]
    return entries, None, len(links), story_title


def _fetch_scribblehub_chapters(story_url: str, timeout: int = 75) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str]]:
    spider = None
    try:
        from spiders.scribblehub import ScribbleHubSpider

        spider = ScribbleHubSpider(novel=story_url, limit=50)
        normalized_url = spider._normalize_url(story_url)
        series_url = spider._story_url_from_any_url(normalized_url)
        html = spider._fetch_page_html(series_url, timeout=timeout)
        soup = BeautifulSoup(html, "html.parser")
        story_title = spider._extract_story_title(soup)
        total_count = spider._extract_total_chapter_count(soup)

        if spider._is_chapter_url(normalized_url):
            start_chapter_id = spider._chapter_id_from_url(normalized_url)
            direct_number, direct_title = spider._chapter_title_from_direct_url(normalized_url)
            if direct_number:
                end_ordinal = min(total_count or direct_number + 49, direct_number + 49)
                target_ordinals = set(range(direct_number, end_ordinal + 1))
                links = spider._collect_chapter_links(
                    story_soup=soup,
                    story_url=series_url,
                    target_ordinals=target_ordinals,
                    fetch_all=False,
                )
                if not links:
                    links = [{
                        "chapter_number": direct_number,
                        "title": direct_title or f"Chapter {direct_number}",
                        "url": normalized_url,
                    }]
            else:
                links = spider._collect_chapter_links(
                    story_soup=soup,
                    story_url=series_url,
                    target_chapter_id=start_chapter_id,
                    fetch_all=True,
                )
                start_ordinal = spider._ordinal_for_chapter_id(links, start_chapter_id)
                if start_ordinal is None:
                    links = [{
                        "chapter_number": 1,
                        "title": direct_title or "Chapter 1",
                        "url": normalized_url,
                    }]
                else:
                    links = [link for link in links if int(link["chapter_number"]) >= start_ordinal]
        else:
            max_entries = min(total_count or 50, 50)
            links = spider._collect_chapter_links(
                story_soup=soup,
                story_url=series_url,
                target_ordinals=set(range(1, max_entries + 1)),
                fetch_all=False,
            )
    except Exception as exc:
        logger.warning("[scribblehub] Chapter list fetch failed: %s", exc)
        return [], "ScribbleHub chapter list failed.", None, None
    finally:
        if spider is not None and getattr(spider, "_browser", None) is not None:
            try:
                spider._browser.close()
            except Exception:
                pass

    entries = [
        ChapterEntry(
            chapter_number=int(link["chapter_number"]),
            title=link.get("title") or f"Chapter {link['chapter_number']}",
            url=link["url"],
        )
        for link in sorted(links, key=lambda item: int(item["chapter_number"]))[:50]
    ]
    return entries, None, total_count or len(links), story_title


def _fetch_novelhall_chapters(story_url: str, timeout: int = 75) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str]]:
    try:
        from spiders.novelhall import NovelHallSpider

        spider = NovelHallSpider(novel=story_url, limit=50)
        series_url = spider._story_url_from_any_url(spider._normalize_url(story_url))
        html = spider._fetch_page_html(series_url, timeout=timeout)
        soup = BeautifulSoup(html, "html.parser")
        story_title = spider._extract_story_title(soup)
        refs = spider._parse_chapter_refs(soup, series_url)
    except Exception as exc:
        logger.warning("[novelhall] Chapter list fetch failed: %s", exc)
        return [], "NovelHall chapter list failed.", None, None

    total_count = len(refs)
    entries = [
        ChapterEntry(
            chapter_number=int(ref["chapter_number"]),
            title=ref.get("title") or f"Chapter {ref['chapter_number']}",
            url=ref["url"],
        )
        for ref in refs[:50]
    ]
    return entries, None, total_count, story_title


def _fetch_novellunar_chapters(story_url: str, timeout: int = 30) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str]]:
    """Build a chapter list for a Novellunar story.

    Novellunar has no on-page table of contents — chapters are sequential
    integers under /novel/<slug>/chapter/<N>. We read the story page for the
    title, then binary-search the highest valid chapter (out-of-range chapters
    return HTTP 200 but with no prose container) to report the total count.
    """
    try:
        from spiders.novellunar import NovellunarSpider

        spider = NovellunarSpider(novel=story_url, limit=50)
        slug = spider.novel_slug
        html = spider._fetch_html(spider._normalize_url(story_url), timeout=timeout)
        soup = BeautifulSoup(html, "html.parser")
        story_title = spider._extract_story_title(soup)
    except Exception as exc:
        logger.warning("[novellunar] Chapter list fetch failed: %s", exc)
        return [], "Novellunar chapter list failed.", None, None

    def chapter_exists(number: int) -> bool:
        try:
            chapter_soup = BeautifulSoup(
                spider._fetch_html(spider._chapter_url(slug, number), timeout=timeout),
                "html.parser",
            )
            return len(spider._extract_chapter_content(chapter_soup).split()) >= 20
        except Exception:
            return False

    if not chapter_exists(1):
        return [], "No chapters found on this Novellunar story page", None, story_title

    low, high, best = 1, 5000, 1
    while low <= high:
        mid = (low + high) // 2
        if chapter_exists(mid):
            best = mid
            low = mid + 1
        else:
            high = mid - 1

    entries = [
        ChapterEntry(
            chapter_number=number,
            title=f"Chapter {number}",
            url=spider._chapter_url(slug, number),
        )
        for number in range(1, min(best, 50) + 1)
    ]
    return entries, None, best, story_title


def _fetch_goodnovel_chapters(story_url: str, timeout: int = 30) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str], dict]:
    try:
        from api.services.goodnovel_api import GoodNovelApiClient

        client = GoodNovelApiClient(timeout=timeout)
        story = client.resolve_story(story_url)
    except Exception as exc:
        logger.warning("[goodnovel] API chapter list failed for story page: %s", exc)
        return [], "GoodNovel API request failed.", None, None, {}

    entries = [
        ChapterEntry(
            chapter_number=ref.chapter_number,
            title=ref.title,
            url=ref.url,
            locked=ref.locked,
        )
        for ref in story.chapters[:50]
    ]
    free_count = sum(1 for ref in story.chapters if not ref.locked)
    paid_count = sum(1 for ref in story.chapters if ref.locked)
    counts = {
        "free_chapter_count": free_count,
        "paid_chapter_count": paid_count,
        "authenticated": client.authenticated,
    }
    return entries, None, len(story.chapters), story.title, counts


def _fetch_webnovel_chapters(story_url: str, timeout: int = 45) -> tuple[list[ChapterEntry], Optional[str], Optional[int], Optional[str], dict]:
    try:
        from spiders.webnovel import WebNovelSpider

        spider = WebNovelSpider(novel=story_url, limit=50)
        catalog_url = spider._catalog_url(spider._normalize_url(story_url))
        html = spider._fetch_html(catalog_url, referer=story_url, timeout=timeout)
        soup = BeautifulSoup(html, "html.parser")
        metadata = spider._extract_story_metadata(soup, spider._story_url_from_catalog(catalog_url))
        links = spider._collect_chapter_links(soup, catalog_url)
    except Exception as exc:
        logger.warning("[webnovel] Chapter list fetch failed: %s", exc)
        return [], "WebNovel chapter list failed. Refresh WebNovel cookies in Settings if Cloudflare is blocking the request.", None, None, {}

    entries = [
        ChapterEntry(
            chapter_number=int(link["chapter_number"]),
            title=link.get("title") or f"Chapter {link['chapter_number']}",
            url=link["url"],
            locked=bool(link.get("locked")) if link.get("locked") is not None else None,
        )
        for link in links[:50]
    ]
    locked_count = sum(1 for link in links if link.get("locked") is True)
    free_count = len(links) - locked_count if links else None
    counts = {
        "free_chapter_count": free_count,
        "paid_chapter_count": locked_count if links else None,
        "authenticated": bool(getattr(spider._client, "_cookies", [])),
    }
    return entries, None, metadata.get("num_parts") or len(links), metadata.get("title"), counts


def _is_inkitt_blocked(html: str) -> bool:
    head = html[:10000]
    return (
        "Just a moment" in head
        or "Attention Required! | Cloudflare" in head
        or "/cdn-cgi/challenge-platform/" in head
    )


def _extract_inkitt_story_id(url: str) -> Optional[str]:
    match = re.search(r"/stories/(\d+)", urllib.parse.urlparse(url).path)
    return match.group(1) if match else None


def _extract_inkitt_chapter_number(url: str) -> Optional[int]:
    match = re.search(r"/stories/\d+/chapters/(\d+)", urllib.parse.urlparse(url).path)
    return int(match.group(1)) if match else None


def _extract_inkitt_story_title(soup: BeautifulSoup) -> Optional[str]:
    title = soup.select_one("h1")
    if title:
        text = _clean_inkitt_text(title.get_text(" ", strip=True))
        if text:
            return text

    og_title = soup.select_one("meta[property='og:title']")
    if og_title:
        text = _clean_inkitt_text(og_title.get("content", ""))
        if text:
            text = re.sub(r"\s+-\s+Free Novel by .*$", "", text, flags=re.IGNORECASE)
            return text

    if soup.title:
        text = _clean_inkitt_text(soup.title.get_text(" ", strip=True))
        text = re.sub(r"\s+by\s+.+?\s+at\s+Inkitt$", "", text, flags=re.IGNORECASE)
        if text:
            return text
    return None


def _extract_inkitt_page_chapter_title(soup: BeautifulSoup) -> Optional[str]:
    for selector in [
        "article#story-text-container h2.chapter-head-title",
        "article#story-text-container h2",
        "h2.chapter-head-title",
    ]:
        element = soup.select_one(selector)
        if element:
            text = _clean_inkitt_text(element.get_text(" ", strip=True))
            if text:
                return text
    return None


def _clean_inkitt_chapter_title(title: str, chapter_number: int) -> str:
    cleaned = _clean_inkitt_text(title)
    cleaned = re.sub(rf"^{chapter_number}\s+", "", cleaned).strip()
    if not cleaned or cleaned.lower() in {"next chapter", "previous chapter"}:
        return f"Chapter {chapter_number}"
    return cleaned


def _clean_inkitt_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\ufeff", " ")).strip()


@router.get("/detect", response_model=SiteDetectResponse)
def detect_site(url: str = Query(..., description="Novel URL to detect")) -> SiteDetectResponse:
    """Detect which site a URL belongs to and extract the novel slug."""
    service = get_site_service()
    return service.detect_site(url)


@router.get("", response_model=list[SiteInfoResponse])
def list_sites() -> list[SiteInfoResponse]:
    """Return info for all supported site configs."""
    service = get_site_service()
    return service.list_sites()


@router.get("/chapters", response_model=ChapterListResponse)
def get_chapters(url: str = Query(..., description="Story-level novel URL")) -> ChapterListResponse:
    """Fetch the chapter list (table of contents) for a novel story URL."""
    from urllib.parse import urlparse

    if not url:
        return ChapterListResponse(valid=False, reason="invalid", message="URL is empty")

    if not url.startswith(("http://", "https://")):
        return ChapterListResponse(
            valid=False, reason="invalid", message="URL must start with http:// or https://"
        )

    service = get_site_service()
    site_info = service._registry.match_url_safe(url)

    if is_chapter_url(url) and (site_info is None or site_info.config_name != "scribblehub"):
        return ChapterListResponse(
            valid=False,
            reason="chapter_url",
            message="This URL points to a chapter page. Please provide a story-level URL.",
        )

    if site_info is None:
        known = ", ".join(service._registry.known_domains())
        return ChapterListResponse(
            valid=False, reason="unsupported", message=f"Unsupported site. Known sites: {known}"
        )

    story_url = url
    story_title: Optional[str] = None
    chapters: list[ChapterEntry] = []
    warning: Optional[str] = None
    total_chapter_count: Optional[int] = None
    extra_counts: dict = {}

    try:
        if site_info.config_name == "wattpad":
            chapters, fetch_warning, total_chapter_count = _fetch_wattpad_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
        elif site_info.config_name == "novelworm":
            chapters, fetch_warning, total_chapter_count, fetched_story_title = _fetch_novelworm_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if not story_title and fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "inkitt":
            chapters, fetch_warning, total_chapter_count, fetched_story_title = _fetch_inkitt_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "jobnib":
            chapters, fetch_warning, total_chapter_count, fetched_story_title = _fetch_jobnib_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "scribblehub":
            chapters, fetch_warning, total_chapter_count, fetched_story_title = _fetch_scribblehub_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "novellunar":
            chapters, fetch_warning, total_chapter_count, fetched_story_title = _fetch_novellunar_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "goodnovel":
            chapters, fetch_warning, total_chapter_count, fetched_story_title, extra_counts = _fetch_goodnovel_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "webnovel":
            chapters, fetch_warning, total_chapter_count, fetched_story_title, extra_counts = _fetch_webnovel_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        elif site_info.config_name == "novelhall":
            chapters, fetch_warning, total_chapter_count, fetched_story_title = _fetch_novelhall_chapters(story_url)
            if fetch_warning:
                warning = fetch_warning
            if fetched_story_title:
                story_title = fetched_story_title
        else:
            warning = f"Chapter listing is not supported for '{site_info.site_name}'"
    except Exception as exc:
        logger.exception("[chapters] Unexpected error fetching chapter list for %s", story_url)
        warning = "Failed to fetch chapter list."
        chapters = []

    if not chapters:
        warning = warning or "No chapters found on this story page"

    return ChapterListResponse(
        valid=True,
        message="Chapter list fetched successfully" if chapters else "No chapters returned",
        story_title=story_title,
        chapter_count=len(chapters),
        total_chapter_count=total_chapter_count,
        chapters=chapters,
        warning=warning if not chapters else None,
        free_chapter_count=extra_counts.get("free_chapter_count"),
        paid_chapter_count=extra_counts.get("paid_chapter_count"),
        authenticated=extra_counts.get("authenticated"),
    )


@router.get("/chapters/total", response_model=BinarySearchTotalResponse)
def get_binary_search_total(url: str = Query(..., description="Story-level novel URL")) -> BinarySearchTotalResponse:
    """Poll the binary-search result for NovelWorm stories.

    Returns immediately. The frontend should call this every 1-2 seconds after
    fetching /api/sites/chapters until done=True.
    """
    if not url or not url.startswith(("http://", "https://")):
        return BinarySearchTotalResponse(url=url, total=None, done=False, fetching=False)

    url_key = url.rstrip("/")
    with _cache_lock:
        entry = _binary_search_cache.get(url_key)

    if entry is None:
        # Not started yet — front-end should call /chapters first
        return BinarySearchTotalResponse(url=url, total=None, done=False, fetching=False)

    if entry["done"]:
        return BinarySearchTotalResponse(
            url=url,
            total=entry["total"],
            done=True,
            fetching=False,
        )

    return BinarySearchTotalResponse(
        url=url,
        total=entry["total"],
        done=False,
        fetching=True,
    )
