from pathlib import Path

from .db import MEDIA_DIR


def media_path(snap_id: str) -> Path:
    return MEDIA_DIR / snap_id


def overlay_path(snap_id: str) -> Path:
    return MEDIA_DIR / f"{snap_id}.overlay.png"


def burn(snap_id: str):
    media_path(snap_id).unlink(missing_ok=True)
    overlay_path(snap_id).unlink(missing_ok=True)
