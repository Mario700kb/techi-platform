"""Recordings of administrator PowerShell sessions.

Everything the device's console shows the operator is written, as it flows, to
an asciicast v2 file (one JSON header line, then `[seconds, "o", text]` events)
that any asciinema player can replay. Only the device's output is recorded —
what the operator types appears there as the console echoes it, and input the
console hides (a password prompt) stays out of the file.

Files live on the backend's data volume, are capped per session, and are
removed after RECORDING_KEEP_DAYS by the nightly cleanup.
"""
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Union

logger = logging.getLogger(__name__)

RECORDING_DIR = Path(os.environ.get("TERMINAL_RECORDING_DIR", "/app/data/terminal-recordings"))
RECORDING_MAX_BYTES = 5 * 1024 * 1024
RECORDING_KEEP_DAYS = 180
_SESSION_ID = re.compile(r"^[0-9a-f]{32}$")


def recording_path(session_id: str) -> Optional[Path]:
    """Where a session's recording lives; None for anything but a session id,
    so a caller can never be steered outside the directory."""
    if not _SESSION_ID.match(session_id or ""):
        return None
    return RECORDING_DIR / f"{session_id}.cast"


class TerminalRecorder:
    def __init__(self, session_id: str, title: str, width: int = 120, height: int = 30, shell: str = "powershell"):
        self.session_id = session_id
        self.path = recording_path(session_id)
        self._started = time.monotonic()
        self._written = 0
        self._file = None
        self._full = False
        if self.path is None:
            return
        try:
            RECORDING_DIR.mkdir(parents=True, exist_ok=True)
            self._file = open(self.path, "a", encoding="utf-8")
            self._write({
                "version": 2, "width": width, "height": height,
                "timestamp": int(datetime.now(timezone.utc).timestamp()),
                "title": title[:200], "env": {"SHELL": shell, "TERM": "xterm-256color"},
            })
        except OSError:
            logger.exception("terminal recording: cannot open %s", self.path)
            self._file = None

    def _write(self, record) -> None:
        if self._file is None or self._full:
            return
        line = json.dumps(record, ensure_ascii=False) + "\n"
        if self._written + len(line) > RECORDING_MAX_BYTES:
            self._full = True
            note = [round(time.monotonic() - self._started, 3), "o", "\r\n[recording limit reached]\r\n"]
            self._file.write(json.dumps(note) + "\n")
            self._file.flush()
            return
        self._file.write(line)
        self._file.flush()
        self._written += len(line)

    def output(self, data: Union[bytes, str, None]) -> None:
        if data is None:
            return
        text = data.decode("utf-8", errors="replace") if isinstance(data, (bytes, bytearray)) else data
        if text:
            self._write([round(time.monotonic() - self._started, 3), "o", text])

    def resize(self, cols: int, rows: int) -> None:
        if cols > 0 and rows > 0:
            self._write([round(time.monotonic() - self._started, 3), "r", f"{cols}x{rows}"])

    @property
    def size_bytes(self) -> int:
        return self._written

    def close(self) -> None:
        if self._file is not None:
            try:
                self._file.close()
            except OSError:
                pass
            self._file = None


def resize_from_frame(text: str) -> Optional[tuple]:
    """(cols, rows) from the terminal's resize control frame, else None."""
    if '"resize"' not in text:
        return None
    try:
        frame = json.loads(text)
    except ValueError:
        return None
    if not isinstance(frame, dict) or frame.get("t") != "resize":
        return None
    try:
        return int(frame.get("cols") or 0), int(frame.get("rows") or 0)
    except (TypeError, ValueError):
        return None


def cleanup_recordings(now: Optional[datetime] = None) -> int:
    """Remove recordings older than the retention period."""
    if not RECORDING_DIR.is_dir():
        return 0
    cutoff = ((now or datetime.now(timezone.utc)) - timedelta(days=RECORDING_KEEP_DAYS)).timestamp()
    removed = 0
    for path in RECORDING_DIR.glob("*.cast"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed
