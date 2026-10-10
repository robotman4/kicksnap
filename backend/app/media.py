import mimetypes
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .db import MEDIA_DIR


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


async def save_upload(upload: UploadFile, dest: Path, limit: int) -> None:
    size = 0
    with dest.open("wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "too big")
            out.write(chunk)
