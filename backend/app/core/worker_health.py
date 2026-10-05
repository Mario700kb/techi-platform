"""In-process liveness of the background workers, for the System status panel.

Each worker registers when it starts (with how often it is expected to tick
and how to tell whether its task is still alive) and beats after every pass.
Nothing is persisted: after a restart only the workers that actually started
appear, and their first beat arrives within one interval.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable, Dict, List, Optional

from app.core.time import utcnow

# A worker is overdue after missing this many beats (plus a fixed grace for
# slow passes on the single-vCPU host).
_MISSED_BEATS = 3
_GRACE = timedelta(seconds=30)


@dataclass
class _Worker:
    label: str
    interval_seconds: Optional[int]
    is_running: Callable[[], bool]
    last_beat: Optional[datetime] = None


_workers: Dict[str, _Worker] = {}


def register(name: str, label: str, interval_seconds: Optional[int], is_running: Callable[[], bool]) -> None:
    """interval_seconds=None for event-driven workers (liveness only)."""
    previous = _workers.get(name)
    _workers[name] = _Worker(label, interval_seconds, is_running, previous.last_beat if previous else None)


def beat(name: str) -> None:
    worker = _workers.get(name)
    if worker is not None:
        worker.last_beat = utcnow()


def snapshot(now: Optional[datetime] = None) -> List[dict]:
    now = now or utcnow()
    result = []
    for name, worker in _workers.items():
        try:
            running = bool(worker.is_running())
        except Exception:
            running = False
        overdue = False
        if running and worker.interval_seconds and worker.last_beat is not None:
            limit = timedelta(seconds=worker.interval_seconds * _MISSED_BEATS) + _GRACE
            overdue = now - worker.last_beat > limit
        result.append({
            "name": name,
            "label": worker.label,
            "state": "ok" if running and not overdue else "down",
            "last_beat": worker.last_beat,
            "reason": None if running and not overdue else ("stopped" if not running else "overdue"),
        })
    return result


def reset_for_tests() -> None:
    _workers.clear()


# Nightly cleanup progress (the result itself is persisted in the audit log).
_cleanup_started_at: Optional[datetime] = None


def cleanup_started() -> None:
    global _cleanup_started_at
    _cleanup_started_at = utcnow()


def cleanup_finished() -> None:
    global _cleanup_started_at
    _cleanup_started_at = None


def cleanup_running_since() -> Optional[datetime]:
    return _cleanup_started_at
