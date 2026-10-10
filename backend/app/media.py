import mimetypes
import os
import time
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .db import MEDIA_DIR

# Upload limits, all server settings. Snaps are end-to-end encrypted, so the server only sees
# bytes: MAX_UPLOAD_MB and DAILY_UPLOAD_MB are enforced here. Video length and bitrate are
# handed to the apps through /me ("limits") and enforced there; the byte caps bound what a
# modified client could get away with.
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))  # one snap file
MAX_VIDEO_SECONDS = int(os.getenv("MAX_VIDEO_SECONDS", "30"))  # recorder stops here, longer gallery videos are refused
VIDEO_KBPS = int(os.getenv("VIDEO_KBPS", "6000"))  # recording bitrate: sets the size, whatever the resolution
DAILY_UPLOAD_MB = int(os.getenv("DAILY_UPLOAD_MB", "500"))  # per user, rolling 24h, 0 = no cap
MB = 1024 * 1024


def limits() -> dict:
    return {"upload_mb": MAX_UPLOAD_MB, "video_seconds": MAX_VIDEO_SECONDS, "video_kbps": VIDEO_KBPS, "daily_mb": DAILY_UPLOAD_MB}


def uploaded_today(conn, user_id: int) -> int:
    """Bytes this user stored in the last 24h (every copy counts: a snap to 3 groups is 3 files)."""
    return conn.execute("SELECT COALESCE(SUM(bytes), 0) FROM uploads WHERE user_id = ? AND at > ?", (user_id, int(time.time()) - 86400)).fetchone()[0]


def check_daily(conn, user_id: int, adding: int) -> None:
    if DAILY_UPLOAD_MB and uploaded_today(conn, user_id) + adding > DAILY_UPLOAD_MB * MB:
        raise HTTPException(429, f"that's today's {DAILY_UPLOAD_MB} MB of snaps, try again tomorrow")


def record_upload(conn, user_id: int, size: int) -> None:
    conn.execute("INSERT INTO uploads (user_id, bytes, at) VALUES (?, ?, ?)", (user_id, size, int(time.time())))


# Uploads we serve back with their own type (report evidence). Anything else, SVG and HTML
# above all, would run as a page on this origin if an admin opened it in a tab.
SAFE_MIMES = {
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/avif", "image/bmp",
    "video/mp4", "video/webm", "video/quicktime", "video/3gpp", "video/x-matroska", "video/ogg",
}
# for every file we hand out: never sniffed into something runnable, never a live page
FILE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
}


def safe_mime(mime: str | None) -> str | None:
    """The bare type ("video/webm;codecs=vp8" -> "video/webm") if it's one we serve, else None."""
    m = (mime or "").split(";")[0].strip().lower()
    return m if m in SAFE_MIMES else None


def upload_mime(upload: UploadFile) -> str | None:
    """Its declared type, or (native apps send application/octet-stream) the one its name implies."""
    return safe_mime(upload.content_type) or safe_mime(mimetypes.guess_type(upload.filename or "")[0])


def media_path(snap_id: str) -> Path:
    return MEDIA_DIR / snap_id


def overlay_path(snap_id: str) -> Path:
    return MEDIA_DIR / f"{snap_id}.overlay.png"


def burn(snap_id: str):
    media_path(snap_id).unlink(missing_ok=True)
    overlay_path(snap_id).unlink(missing_ok=True)


async def save_upload(upload: UploadFile, dest: Path, limit: int) -> int:
    """Streams it to disk, refusing past `limit` bytes. Returns the size."""
    size = 0
    with dest.open("wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"too big: {limit // MB} MB max" if limit >= MB else "too big")
            out.write(chunk)
    return size
