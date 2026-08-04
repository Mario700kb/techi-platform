"""Terminal ticket lifetime must outlive one heartbeat cycle.

2026-08-04, device 729 (the only Linux endpoint). Opening a terminal enqueues
an `open_terminal` action that the agent only discovers on its next heartbeat —
there is no push channel. The ticket and the action deadline were both a flat
60s while the Linux heartbeat interval is 250s, so the click only worked when
it happened to land in the last ~60s of a cycle. Observed delivery latency on
that device: 34s (worked), 56s (worked, barely), and three attempts never
delivered at all — the actions expired with sent_at NULL.

These tests pin the derivation, not a magic number, so retuning an interval
cannot silently reopen the race.

Windows is deliberately covered too: it has no terminal capability today, but
the derivation must not special-case any platform, and Windows must keep the
larger TTL its own 300s interval implies rather than inheriting a Linux value.
"""

import pytest

from app.services import agent_config_service as cfg
from app.services import terminal_service as ts


class _FakeQuery:
    def __init__(self, value, raises=False):
        self._value = value
        self._raises = raises

    def filter(self, *_a, **_k):
        return self

    def scalar(self):
        if self._raises:
            raise RuntimeError("db unavailable")
        return self._value


class _FakeDB:
    def __init__(self, platform=None, raises=False):
        self._platform = platform
        self._raises = raises

    def query(self, *_a, **_k):
        return _FakeQuery(self._platform, self._raises)


# ── the derivation ───────────────────────────────────────────────────────── #

def test_ttl_outlives_a_full_linux_heartbeat_cycle():
    """The regression itself: 250s interval must not get a 60s ticket."""
    interval = cfg.get_heartbeat_interval("linux")
    ttl = ts.ticket_ttl_seconds("linux")
    assert interval == 250
    assert ttl > interval, "a ticket shorter than one heartbeat cycle is a race"
    assert ttl == interval + ts.TICKET_ATTACH_GRACE_SECONDS


def test_the_observed_failures_would_now_succeed():
    """34s and 56s both worked; the three that expired did not. Every latency
    up to a full cycle must now fit inside the ticket."""
    ttl = ts.ticket_ttl_seconds("linux")
    for observed_latency in (34, 56, 250):
        assert observed_latency < ttl


def test_windows_keeps_its_own_larger_interval():
    """Windows must not inherit a Linux-shaped TTL — the fleet runs 300s."""
    assert cfg.get_heartbeat_interval("windows") == 300
    assert ts.ticket_ttl_seconds("windows") == 300 + ts.TICKET_ATTACH_GRACE_SECONDS


def test_every_platform_gets_a_ttl_above_its_interval():
    for platform in cfg.PLATFORM_HEARTBEAT_DEFAULTS:
        assert ts.ticket_ttl_seconds(platform) > cfg.get_heartbeat_interval(platform)


def test_unknown_platform_falls_back_to_the_windows_default():
    """_policy_platform_key maps anything unrecognised to windows; the TTL must
    still clear that interval rather than collapsing to the bare grace."""
    ttl = ts.ticket_ttl_seconds("plan9")
    assert ttl == cfg.get_heartbeat_interval("plan9") + ts.TICKET_ATTACH_GRACE_SECONDS
    assert ttl > ts.TICKET_ATTACH_GRACE_SECONDS


def test_none_platform_is_safe():
    assert ts.ticket_ttl_seconds(None) > ts.TICKET_ATTACH_GRACE_SECONDS


# ── per-device resolution ────────────────────────────────────────────────── #

def test_device_lookup_drives_the_ttl():
    svc = ts.TerminalService(_FakeDB(platform="linux"))
    assert svc.ticket_ttl_for_device(729) == ts.ticket_ttl_seconds("linux")


def test_windows_device_resolves_to_the_windows_ttl():
    svc = ts.TerminalService(_FakeDB(platform="windows"))
    assert svc.ticket_ttl_for_device(1) == ts.ticket_ttl_seconds("windows")


def test_db_failure_never_blocks_opening_a_terminal():
    """A lookup problem must degrade, not raise: the operator still gets a
    session, just with the conservative fallback."""
    svc = ts.TerminalService(_FakeDB(raises=True))
    assert svc.ticket_ttl_for_device(729) == ts.ticket_ttl_seconds(None)


def test_missing_device_row_degrades_cleanly():
    svc = ts.TerminalService(_FakeDB(platform=None))
    assert svc.ticket_ttl_for_device(99999) > ts.TICKET_ATTACH_GRACE_SECONDS


# ── the grace period is unchanged ────────────────────────────────────────── #

def test_attach_grace_is_still_sixty_seconds():
    """Only the delivery wait was wrong. The time both sides get to attach,
    once the agent actually knows, was never the problem."""
    assert ts.TICKET_ATTACH_GRACE_SECONDS == 60


def test_legacy_constant_still_importable():
    """terminal.py and any external caller still import TICKET_TTL_SECONDS."""
    assert ts.TICKET_TTL_SECONDS == ts.TICKET_ATTACH_GRACE_SECONDS


@pytest.mark.parametrize("interval,expected", [(60, 120), (250, 310), (300, 360), (600, 660)])
def test_derivation_is_pure_arithmetic(monkeypatch, interval, expected):
    monkeypatch.setattr(cfg, "get_heartbeat_interval", lambda _p: interval)
    assert ts.ticket_ttl_seconds("anything") == expected
