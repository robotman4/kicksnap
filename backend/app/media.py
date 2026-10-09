from pathlib import Path

from fastapi import HTTPException, UploadFile

from .db import MEDIA_DIR


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
