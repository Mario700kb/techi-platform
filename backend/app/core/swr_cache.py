"""Stale-while-revalidate cache for expensive dashboard read models.

A fresh entry is returned as is. An entry past its TTL but still within its
max age is returned immediately while one background thread recomputes it, so
a reader never waits for a recompute it did not need. Only a missing (or very
old) entry is computed inline, and then only once per key: concurrent callers
wait for that single computation instead of repeating it on a single-vCPU host.

Background recomputes open their own session on the caller's engine, because
the request session is closed as soon as the response is sent.
"""
import logging
import threading
import time
from collections import OrderedDict
from typing import Callable, Generic, Optional, TypeVar

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

T = TypeVar("T")


class SWRCache(Generic[T]):
    def __init__(self, name: str, ttl: float, max_age: float, max_size: int = 20):
        self.name = name
        self.ttl = ttl
        self.max_age = max_age
        self.max_size = max_size
        self._entries: "OrderedDict[str, tuple[T, float]]" = OrderedDict()
        self._lock = threading.Lock()
        self._key_locks: dict[str, threading.Lock] = {}
        self._refreshing: set[str] = set()

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def get(self, key: str, db: Session, compute: Callable[[Session], T]) -> T:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
        if entry is not None:
            age = now - entry[1]
            if age < self.ttl:
                return entry[0]
            if age < self.max_age:
                self._refresh_in_background(key, db, compute)
                return entry[0]

        with self._key_lock(key):
            with self._lock:
                entry = self._entries.get(key)
            if entry is not None and time.monotonic() - entry[1] < self.ttl:
                return entry[0]
            value = compute(db)
            self._store(key, value)
            return value

    def warm(self, key: str, db: Session, compute: Callable[[Session], T]) -> None:
        """Compute an entry ahead of the first reader (e.g. at startup)."""
        self._refresh_in_background(key, db, compute)

    # ── internals ────────────────────────────────────────────────────────
    def _key_lock(self, key: str) -> threading.Lock:
        with self._lock:
            return self._key_locks.setdefault(key, threading.Lock())

    def _store(self, key: str, value: T) -> None:
        with self._lock:
            self._entries[key] = (value, time.monotonic())
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_size:
                self._entries.popitem(last=False)

    def _refresh_in_background(self, key: str, db: Session, compute: Callable[[Session], T]) -> None:
        with self._lock:
            if key in self._refreshing:
                return
            self._refreshing.add(key)
        bind = db.get_bind()

        def run() -> None:
            try:
                with self._key_lock(key):
                    with Session(bind=bind) as session:
                        self._store(key, compute(session))
            except Exception:
                logger.exception("%s cache refresh failed for %s", self.name, key)
            finally:
                with self._lock:
                    self._refreshing.discard(key)

        threading.Thread(target=run, name=f"swr-{self.name}", daemon=True).start()


def scope_cache_key(scope, suffix: Optional[str] = None) -> str:
    if scope is None:
        key = "global"
    else:
        key = f"c{sorted(scope.client_ids)}g{sorted(scope.group_ids)}d{sorted(scope.device_ids)}"
    return f"{key}:{suffix}" if suffix else key
