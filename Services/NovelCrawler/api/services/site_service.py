"""Site detection service."""

from __future__ import annotations

import logging
import os
import re
import urllib.parse
from typing import Optional

from api.models.site_info import NovelMetadata, SiteDetectResponse, SiteInfoResponse
from api.services.config_discovery import slug_from_url
from api.services.site_registry import SiteRegistry
from utils.proxy import requests_proxies

logger = logging.getLogger(__name__)

_SEASON_RE = re.compile(r"[Ss]eason\s*(\d+)\s*(?:of|/)\s*(\d+)")


def _fetch_wattpad_metadata(story_id: str) -> Optional[NovelMetadata]:
    from api.services.wattpad_api import get

    api_url = (
        f"https://www.wattpad.com/api/v3/stories/{story_id}"
        f"?fields=id,title,description,cover,completed,mature,"
        f"readCount,voteCount,commentCount,numParts,rating,tags,"
        f"language,isPaywalled,paidModel,"
        f"user(name,avatar,fullname),"
        f"parts(id,title,url,length,createDate,voteCount,readCount)"
    )

    try:
        resp = get(api_url, story_id=story_id, timeout=20)
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception:
        return None

    if not isinstance(data, dict):
        return None

    user = data.get("user", {})
    description = data.get("description", "") or ""
    season_match = _SEASON_RE.search(description)
    season_current = int(season_match.group(1)) if season_match else None
    season_total = int(season_match.group(2)) if season_match else None

    return NovelMetadata(
        title=data.get("title"),
        author=user.get("name"),
        authors=[user.get("name")] if user.get("name") else None,
        author_fullname=user.get("fullname") or user.get("name"),
        author_avatar=user.get("avatar"),
        cover_url=data.get("cover"),
        description=description,
        views=data.get("readCount"),
        stars=data.get("voteCount"),
        comment_count=data.get("commentCount"),
        num_parts=data.get("numParts"),
        language=data.get("language"),
        tags=data.get("tags") or [],
        completed=data.get("completed"),
        mature=data.get("mature"),
        is_paywalled=data.get("isPaywalled"),
        season_current=season_current,
        season_total=season_total,
    )


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


_SCRIBBLEHUB_SERIES_RE = re.compile(r"/series/(\d+)/([^/?#]+)", re.IGNORECASE)
_SCRIBBLEHUB_CHAPTER_RE = re.compile(r"/read/(\d+)-([^/?#]+)/chapter/(\d+)", re.IGNORECASE)


def _scribblehub_slug_from_url(url: str) -> Optional[str]:
    path = urllib.parse.urlparse(url).path
    match = _SCRIBBLEHUB_SERIES_RE.search(path)
    if match:
        return match.group(2)
    match = _SCRIBBLEHUB_CHAPTER_RE.search(path)
    if match:
        return match.group(2)
    return None


def _title_from_slug(slug: str | None) -> Optional[str]:
    if not slug:
        return None
    return re.sub(r"[-_]+", " ", slug).strip().title() or None


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _fetch_scribblehub_metadata(url: str) -> tuple[Optional[str], Optional[NovelMetadata]]:
    spider = None
    try:
        from bs4 import BeautifulSoup
        from spiders.scribblehub import ScribbleHubSpider

        spider = ScribbleHubSpider(novel=url, limit=1)
        story_url = spider._story_url_from_any_url(url)
        html = spider._fetch_page_html(story_url)
        soup = BeautifulSoup(html, "html.parser")
        metadata = spider._extract_story_metadata(soup, story_url)
    except Exception as exc:
        logger.debug("[scribblehub] Metadata fetch failed for %s: %s", url, exc)
        return None, None
    finally:
        if spider is not None and getattr(spider, "_browser", None) is not None:
            try:
                spider._browser.close()
            except Exception:
                pass

    title = metadata.get("title")
    author = metadata.get("author")
    novel_meta = NovelMetadata(
        title=title,
        author=author,
        authors=metadata.get("authors") or ([author] if author else None),
        cover_url=metadata.get("cover_url"),
        description=metadata.get("description"),
        num_parts=metadata.get("num_parts"),
        tags=metadata.get("tags") or [],
    )
    return title, novel_meta


def _fetch_novelhall_metadata(url: str) -> tuple[Optional[str], Optional[NovelMetadata]]:
    try:
        from bs4 import BeautifulSoup
        from spiders.novelhall import NovelHallSpider

        spider = NovelHallSpider(novel=url, limit=1)
        story_url = spider._story_url_from_any_url(spider._normalize_url(url))
        html = spider._fetch_page_html(story_url)
        soup = BeautifulSoup(html, "html.parser")
        metadata = spider._extract_story_metadata(soup, story_url)
    except Exception as exc:
        logger.debug("[novelhall] Metadata fetch failed for %s: %s", url, exc)
        return None, None

    title = metadata.get("title")
    author = metadata.get("author")
    novel_meta = NovelMetadata(
        title=title,
        author=author,
        authors=metadata.get("authors") or ([author] if author else None),
        cover_url=metadata.get("cover_url"),
        description=metadata.get("description"),
        tags=metadata.get("tags") or [],
    )
    return title, novel_meta


def _fetch_novellunar_metadata(url: str) -> tuple[Optional[str], Optional[NovelMetadata]]:
    try:
        from bs4 import BeautifulSoup
        from spiders.novellunar import NovellunarSpider

        spider = NovellunarSpider(novel=url, limit=1)
        story_url = spider._normalize_url(url)
        # If a chapter URL was passed, drop back to the story page for metadata.
        if spider._chapter_number_from_url(story_url) is not None:
            story_url = f"https://novellunar.com/novel/{spider.novel_slug}"
        soup = BeautifulSoup(spider._fetch_html(story_url), "html.parser")
        metadata = spider._extract_story_metadata(soup, story_url)
    except Exception as exc:
        logger.debug("[novellunar] Metadata fetch failed for %s: %s", url, exc)
        return None, None

    title = metadata.get("title")
    novel_meta = NovelMetadata(
        title=title,
        author=metadata.get("author"),
        authors=metadata.get("authors"),
        cover_url=metadata.get("cover_url"),
        description=metadata.get("description"),
        tags=metadata.get("tags") or [],
    )
    return title, novel_meta


def _fetch_webnovel_metadata(url: str) -> tuple[Optional[str], Optional[NovelMetadata], Optional[str]]:
    try:
        from bs4 import BeautifulSoup
        from spiders.webnovel import WebNovelSpider

        spider = WebNovelSpider(novel=url, limit=1)
        normalized_url = spider._normalize_url(url)
        catalog_url = spider._catalog_url(normalized_url)
        soup = BeautifulSoup(spider._fetch_html(catalog_url, referer=normalized_url), "html.parser")
        metadata = spider._extract_story_metadata(soup, spider._story_url_from_catalog(catalog_url))
        slug = spider.novel_slug
    except Exception as exc:
        logger.debug("[webnovel] Metadata fetch failed for %s: %s", url, exc)
        return None, None, None

    title = metadata.get("title")
    novel_meta = NovelMetadata(
        title=title,
        author=metadata.get("author"),
        authors=metadata.get("authors"),
        cover_url=metadata.get("cover_url"),
        description=metadata.get("description"),
        num_parts=metadata.get("num_parts"),
        tags=metadata.get("tags") or [],
    )
    return title, novel_meta, slug


def _fetch_inkitt_metadata(url: str) -> tuple[Optional[str], Optional[NovelMetadata]]:
    try:
        import json
        import requests
        from bs4 import BeautifulSoup

        resp = requests.get(
            url,
            headers=_INKITT_HEADERS,
            timeout=20,
            proxies=requests_proxies("inkitt"),
        )
        if resp.status_code != 200:
            return None, None
        if _inkitt_blocked(resp.text):
            return None, None
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception:
        return None, None

    json_ld: dict = {}
    for script in soup.select("script[type='application/ld+json']"):
        raw = script.get_text(strip=True)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        candidates = data if isinstance(data, list) else [data]
        for candidate in candidates:
            if isinstance(candidate, dict) and candidate.get("@type") == "Article":
                json_ld = candidate
                break
        if json_ld:
            break

    title = _inkitt_story_title(soup, json_ld)
    author = _inkitt_author(soup, json_ld)
    cover_url = _inkitt_cover_url(soup, json_ld)
    description = json_ld.get("description") or _meta_content(soup, "meta[name='description']")
    chapter_count = _inkitt_chapter_count(soup, url)

    is_paywalled = False
    html = resp.text
    if "globalData.authorPatronTiers" in html:
        match = re.search(r"globalData\.authorPatronTiers\s*=\s*\[(.*?)\];", html)
        if match and match.group(1).strip():
            is_paywalled = True
    if not is_paywalled and ('id="patron-tiers"' in html or 'class="patron-tiers"' in html or 'patron-tiers' in html):
        if soup.select_one("#patron-tiers"):
            is_paywalled = True

    metadata = NovelMetadata(
        title=title,
        author=author,
        authors=[author] if author else None,
        cover_url=cover_url,
        description=description,
        num_parts=chapter_count,
        is_paywalled=is_paywalled,
    )
    return title, metadata


def _inkitt_blocked(html: str) -> bool:
    head = html[:10000]
    return (
        "Just a moment" in head
        or "Attention Required! | Cloudflare" in head
        or "/cdn-cgi/challenge-platform/" in head
    )


def _inkitt_story_title(soup, json_ld: dict) -> Optional[str]:
    h1 = soup.select_one("h1")
    if h1:
        text = _clean_inkitt_text(h1.get_text(" ", strip=True))
        if text:
            return text

    headline = json_ld.get("headline")
    if headline:
        return _clean_inkitt_text(str(headline))

    og_title = _meta_content(soup, "meta[property='og:title']")
    if og_title:
        return re.sub(r"\s+-\s+Free Novel by .*$", "", og_title, flags=re.IGNORECASE).strip()
    return None


def _inkitt_author(soup, json_ld: dict) -> Optional[str]:
    author = _meta_content(soup, "meta[name='author']")
    if author:
        return author

    json_author = json_ld.get("author")
    if isinstance(json_author, dict) and json_author.get("name"):
        return _clean_inkitt_text(str(json_author["name"]))

    for anchor in soup.select(".author-link"):
        text = _clean_inkitt_text(anchor.get_text(" ", strip=True))
        if text and "stories" not in text.lower():
            return text
    return None


def _inkitt_cover_url(soup, json_ld: dict) -> Optional[str]:
    image = json_ld.get("image")
    if isinstance(image, dict) and image.get("url"):
        return str(image["url"])
    if isinstance(image, str):
        return image
    return _meta_content(soup, "meta[property='og:image']") or None


def _inkitt_chapter_count(soup, url: str) -> Optional[int]:
    story_id_match = re.search(r"/stories/(\d+)", urllib.parse.urlparse(url).path)
    if not story_id_match:
        return None

    story_id = story_id_match.group(1)
    chapter_numbers: set[int] = set()
    for anchor in soup.select("a[href*='/stories/'][href*='/chapters/']"):
        href = urllib.parse.urljoin("https://www.inkitt.com", anchor.get("href", ""))
        match = re.search(r"/stories/(\d+)/chapters/(\d+)", urllib.parse.urlparse(href).path)
        if match and match.group(1) == story_id:
            chapter_numbers.add(int(match.group(2)))
    return len(chapter_numbers) or None


def _meta_content(soup, selector: str) -> Optional[str]:
    element = soup.select_one(selector)
    if not element:
        return None
    value = element.get("content", "")
    return _clean_inkitt_text(value) if value else None


def _clean_inkitt_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\ufeff", " ")).strip()


class SiteService:
    def __init__(self) -> None:
        self._registry = SiteRegistry()

    def detect_site(self, url: str) -> SiteDetectResponse:
        if not url:
            return SiteDetectResponse(valid=False, message="URL cannot be empty.")

        if not url.startswith(("http://", "https://")):
            return SiteDetectResponse(valid=False, message="URL must start with http:// or https://.")

        site_info = self._registry.match_url_safe(url)

        if site_info is None:
            known = ", ".join(self._registry.known_domains())
            return SiteDetectResponse(
                valid=False,
                message=f"Unsupported site. Known sites: {known}",
            )

        slug = slug_from_url(url)
        if not slug:
            return SiteDetectResponse(
                valid=False,
                site=SiteInfoResponse(
                    config_name=site_info.config_name,
                    site_name=site_info.site_name,
                    base_url=site_info.base_url,
                    rate_limit=site_info.rate_limit,
                ),
                message="Could not extract a novel slug from the URL.",
            )

        resolved_url: Optional[str] = None
        story_title: Optional[str] = None
        novel_meta: Optional[NovelMetadata] = None

        if site_info.config_name == "wattpad":
            from api.services.wattpad_url_resolver import resolve_wattpad_url

            story_info = resolve_wattpad_url(url)
            if story_info:
                resolved_url = story_info.detected_url
                story_title = story_info.story_title
                slug = story_info.story_id
                novel_meta = _fetch_wattpad_metadata(story_info.story_id)
            else:
                resolved_url = url

        elif site_info.config_name == "novelworm":
            try:
                from api.services.novelworm_api import NovelWormApiClient

                story_title, metadata = NovelWormApiClient(timeout=20).resolve_metadata(url)
                if metadata:
                    novel_meta = NovelMetadata(**metadata)
            except Exception:
                story_title = None

        elif site_info.config_name == "goodnovel":
            try:
                from api.services.goodnovel_api import GoodNovelApiClient

                story_title, metadata = GoodNovelApiClient(timeout=20).resolve_metadata(url)
                if metadata:
                    novel_meta = NovelMetadata(**metadata)
            except Exception:
                story_title = None

        elif site_info.config_name == "inkitt":
            story_title, novel_meta = _fetch_inkitt_metadata(url)

        elif site_info.config_name == "jobnib":
            story_title = slug.replace("-", " ").title() if slug else None

        elif site_info.config_name == "novellunar":
            story_title, novel_meta = _fetch_novellunar_metadata(url)

        elif site_info.config_name == "webnovel":
            story_title, novel_meta, webnovel_slug = _fetch_webnovel_metadata(url)
            if webnovel_slug:
                slug = webnovel_slug
            elif slug:
                slug = re.sub(r"_\d+$", "", slug)
                slug = re.sub(r"/catalog$", "", slug)

        elif site_info.config_name == "scribblehub":
            scribblehub_slug = _scribblehub_slug_from_url(url)
            if scribblehub_slug:
                slug = scribblehub_slug
            story_title = _title_from_slug(slug)
            if _env_flag("SCRIBBLEHUB_DETECT_METADATA"):
                fetched_title, novel_meta = _fetch_scribblehub_metadata(url)
                if fetched_title:
                    story_title = fetched_title

        elif site_info.config_name == "novelhall":
            story_title = _title_from_slug(re.sub(r"-\d+$", "", slug)) if slug else None
            fetched_title, novel_meta = _fetch_novelhall_metadata(url)
            if fetched_title:
                story_title = fetched_title

        return SiteDetectResponse(
            site=SiteInfoResponse(
                config_name=site_info.config_name,
                site_name=site_info.site_name,
                base_url=site_info.base_url,
                rate_limit=site_info.rate_limit,
            ),
            slug=slug,
            valid=True,
            message="Site detected successfully.",
            story_title=story_title,
            resolved_url=resolved_url,
            novel_metadata=novel_meta,
        )

    def list_sites(self) -> list[SiteInfoResponse]:
        return [
            SiteInfoResponse(
                config_name=s.config_name,
                site_name=s.site_name,
                base_url=s.base_url,
                rate_limit=s.rate_limit,
            )
            for s in self._registry.sites
        ]


_site_service: Optional[SiteService] = None


def get_site_service() -> SiteService:
    global _site_service
    if _site_service is None:
        _site_service = SiteService()
    return _site_service
