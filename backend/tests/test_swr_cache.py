import threading
import time

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.swr_cache import SWRCache, scope_cache_key


def _session() -> Session:
    return Session(bind=create_engine("sqlite:///:memory:"))


def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_fresh_entry_is_not_recomputed():
    cache: SWRCache[int] = SWRCache("t", ttl=60, max_age=120)
    calls = []
    compute = lambda _s: calls.append(1) or len(calls)  # noqa: E731
    db = _session()
    assert cache.get("k", db, compute) == 1
    assert cache.get("k", db, compute) == 1
    assert len(calls) == 1


def test_stale_entry_is_served_immediately_and_refreshed_in_background():
    cache: SWRCache[str] = SWRCache("t", ttl=0.05, max_age=60)
    db = _session()
    cache.get("k", db, lambda _s: "old")
    time.sleep(0.06)

    release = threading.Event()

    def slow(_s):
        release.wait(2)
        return "new"

    started = time.monotonic()
    assert cache.get("k", db, slow) == "old"
    assert time.monotonic() - started < 0.5, "a stale read must not wait for the recompute"
    release.set()
    assert _wait_for(lambda: cache.get("k", db, lambda _s: "unused") == "new")


def test_missing_entry_is_computed_once_for_concurrent_readers():
    cache: SWRCache[int] = SWRCache("t", ttl=60, max_age=120)
    db = _session()
    calls = []

    def compute(_s):
        calls.append(1)
        time.sleep(0.1)
        return 42

    results = []
    threads = [threading.Thread(target=lambda: results.append(cache.get("k", db, compute))) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [42] * 5
    assert len(calls) == 1


def test_entry_past_max_age_is_recomputed_inline():
    cache: SWRCache[str] = SWRCache("t", ttl=0.01, max_age=0.02)
    db = _session()
    cache.get("k", db, lambda _s: "old")
    time.sleep(0.03)
    assert cache.get("k", db, lambda _s: "new") == "new"


def test_failed_background_refresh_keeps_serving_the_last_value():
    cache: SWRCache[str] = SWRCache("t", ttl=0.01, max_age=60)
    db = _session()
    cache.get("k", db, lambda _s: "old")
    time.sleep(0.02)

    def boom(_s):
        raise RuntimeError("db down")

    assert cache.get("k", db, boom) == "old"
    assert _wait_for(lambda: "k" not in cache._refreshing)
    assert cache.get("k", db, boom) == "old"


def test_scope_cache_key_distinguishes_scopes_and_suffixes():
    class Scope:
        client_ids = {2, 1}
        group_ids = set()
        device_ids = {9}

    assert scope_cache_key(None) == "global"
    assert scope_cache_key(None, "30") == "global:30"
    assert scope_cache_key(Scope(), "30") == "c[1, 2]g[]d[9]:30"
