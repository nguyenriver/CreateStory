"""SQLAlchemy models for NovelCrawler metadata."""

from __future__ import annotations

import base64
import hashlib
import os
from datetime import datetime, timezone

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import BigInteger, Boolean, DateTime, Integer, String, Text, TypeDecorator, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from api.db import Base

_ENCRYPTED_COOKIE_PREFIX = "enc:v1:"
_COOKIE_ENCRYPTION_KEY_ENV = "NOVEL_CRAWLER_COOKIE_ENCRYPTION_KEY"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _cookie_fernet() -> Fernet:
    key = _cookie_encryption_key()
    if not key:
        raise RuntimeError(
            f"{_COOKIE_ENCRYPTION_KEY_ENV} or COOKIE_ENCRYPTION_KEY must be set before storing crawler cookies."
        )
    try:
        return Fernet(key.encode("utf-8"))
    except ValueError:
        derived = base64.urlsafe_b64encode(hashlib.sha256(key.encode("utf-8")).digest())
        return Fernet(derived)


def _cookie_encryption_key() -> str:
    for name in (_COOKIE_ENCRYPTION_KEY_ENV, "COOKIE_ENCRYPTION_KEY"):
        key = os.getenv(name, "").strip()
        if key:
            return key
        file_path = os.getenv(f"{name}_FILE", "").strip()
        if file_path:
            try:
                return open(file_path, encoding="utf-8").read().strip()
            except OSError as exc:
                raise RuntimeError(f"Unable to read {name}_FILE: {exc}") from exc
    return ""


def _encrypt_cookie_value(value: str) -> str:
    if value.startswith(_ENCRYPTED_COOKIE_PREFIX):
        return value
    encrypted = _cookie_fernet().encrypt(value.encode("utf-8")).decode("utf-8")
    return f"{_ENCRYPTED_COOKIE_PREFIX}{encrypted}"


def encrypt_plaintext_cookie_values(db) -> int:
    """Rewrite legacy plaintext cookie values in-place using the current key."""
    migrated = 0
    for table_name in (
        "inkitt_cookies",
        "goodnovel_cookies",
        "scribblehub_cookies",
        "webnovel_cookies",
        "jobnib_cookies",
        "novelhall_cookies",
    ):
        rows = db.execute(
            text(f"SELECT id, value FROM {table_name} WHERE value NOT LIKE :prefix"),
            {"prefix": f"{_ENCRYPTED_COOKIE_PREFIX}%"},
        ).mappings()
        for row in rows:
            db.execute(
                text(f"UPDATE {table_name} SET value = :value WHERE id = :id"),
                {"id": row["id"], "value": _encrypt_cookie_value(row["value"] or "")},
            )
            migrated += 1
    if migrated:
        db.commit()
    return migrated


class EncryptedCookieValue(TypeDecorator[str]):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect) -> str | None:
        if value is None or value.startswith(_ENCRYPTED_COOKIE_PREFIX):
            return value
        return _encrypt_cookie_value(value)

    def process_result_value(self, value: str | None, dialect) -> str | None:
        if value is None or not value.startswith(_ENCRYPTED_COOKIE_PREFIX):
            return value
        token = value[len(_ENCRYPTED_COOKIE_PREFIX):]
        try:
            return _cookie_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
        except InvalidToken as exc:
            raise RuntimeError("Failed to decrypt crawler cookie value; check the configured encryption key.") from exc


class CrawlSessionRecord(Base):
    __tablename__ = "crawl_sessions"

    crawl_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_by_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    site_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    novel_name: Mapped[str] = mapped_column(Text, nullable=False, default="")
    chapters_crawled: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    chapters_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(64), nullable=False, default="pending", index=True)
    started_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    finished_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    combined_file: Mapped[str] = mapped_column(Text, nullable=False, default="")
    combined_md_file: Mapped[str] = mapped_column(Text, nullable=False, default="")
    completed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    output_format: Mapped[str] = mapped_column(String(32), nullable=False, default="md")
    source_url: Mapped[str] = mapped_column(Text, nullable=False, default="")
    raw: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class CrawlOutputFileRecord(Base):
    __tablename__ = "crawl_output_files"

    file_id: Mapped[str] = mapped_column(String(512), primary_key=True)
    crawl_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(Text, nullable=False, default="")
    file_path: Mapped[str] = mapped_column(Text, nullable=False, default="")
    file_ext: Mapped[str] = mapped_column(String(16), nullable=False, default="")
    file_role: Mapped[str] = mapped_column(String(32), nullable=False, default="chapter", index=True)
    chapter_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    raw: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class InkittCookie(Base):
    """Stores Inkitt login cookies (user_credentials, cf_clearance) in the database.

    Only the most recently saved set of cookies is considered valid at any time.
    Expired cookies are skipped at read time.
    """

    __tablename__ = "inkitt_cookies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(EncryptedCookieValue(), nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default=".inkitt.com")
    path: Mapped[str] = mapped_column(String(64), nullable=False, default="/")
    secure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class GoodNovelCookie(Base):
    """Stores user-provided GoodNovel session cookies (chiefly the ``TOKEN`` login cookie).

    GoodNovel authenticates the web reader with cookies scoped to ``.goodnovel.com``,
    which are also sent to the ``api-akm.goodnovel.com`` API host. Replaying a logged-in
    account's cookies lets the crawler read every chapter that account can access for free
    (universally-free chapters plus any the account has unlocked with bonus/earned coins).

    Only the most recently saved set of cookies is considered valid at any time.
    Expired cookies are skipped at read time.
    """

    __tablename__ = "goodnovel_cookies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(EncryptedCookieValue(), nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default=".goodnovel.com")
    path: Mapped[str] = mapped_column(String(64), nullable=False, default="/")
    secure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class ScribbleHubCookie(Base):
    """Stores user-provided ScribbleHub session cookies (chiefly cf_clearance) in the database.

    ScribbleHub sits behind a Cloudflare managed challenge, so the crawler reuses a
    cookie set captured from a real browser. cf_clearance is bound to the IP and the
    User-Agent that solved the challenge, so the matching User-Agent is stored alongside
    the cookies and replayed on every request.

    Only the most recently saved set of cookies is considered valid at any time.
    Expired cookies are skipped at read time.
    """

    __tablename__ = "scribblehub_cookies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(EncryptedCookieValue(), nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default=".scribblehub.com")
    path: Mapped[str] = mapped_column(String(64), nullable=False, default="/")
    secure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class NovelHallCookie(Base):
    """Stores user-provided NovelHall session cookies (chiefly ``cf_clearance``) in the database.

    NovelHall sits behind a Cloudflare managed challenge, so the crawler reuses a cookie set
    captured from a real browser or auto-minted by FlareSolverr. ``cf_clearance`` is bound to the
    IP and the User-Agent that solved the challenge, so the matching User-Agent is stored
    alongside the cookies and replayed on every request.

    Only the most recently saved set of cookies is considered valid at any time.
    Expired cookies are skipped at read time.
    """

    __tablename__ = "novelhall_cookies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(EncryptedCookieValue(), nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default=".novelhall.com")
    path: Mapped[str] = mapped_column(String(64), nullable=False, default="/")
    secure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class WebNovelCookie(Base):
    """Stores user-provided WebNovel cookies and their matching User-Agent.

    WebNovel protects catalog/chapter endpoints with Cloudflare. The crawler
    replays cookies captured from a real browser session, especially
    cf_clearance, together with the User-Agent that generated them. Login
    cookies may also let the account read chapters it has already unlocked.

    Only the most recently saved set of cookies is considered valid at any
    time. Expired cookies are skipped at read time.
    """

    __tablename__ = "webnovel_cookies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(EncryptedCookieValue(), nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default=".webnovel.com")
    path: Mapped[str] = mapped_column(String(64), nullable=False, default="/")
    secure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class JobnibCookie(Base):
    """Stores Jobnib browser cookies and the exact matching User-Agent."""

    __tablename__ = "jobnib_cookies"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(EncryptedCookieValue(), nullable=False, default="")
    domain: Mapped[str] = mapped_column(String(256), nullable=False, default=".jobnib.com")
    path: Mapped[str] = mapped_column(String(64), nullable=False, default="/")
    secure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
