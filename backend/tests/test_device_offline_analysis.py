"""
Unit tests for device_offline_analysis_service.

All tests are pure Python — no database, no HTTP client.
Fake Device objects are built with types.SimpleNamespace.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.device_offline_analysis_service import (
    CONFIDENCE_HIGH,
    CONFIDENCE_LOW,
    CONFIDENCE_MEDIUM,
    REASON_AGENT_STOPPED,
    REASON_NETWORK_LOST,
    REASON_POSSIBLY_POWER_OFF,
    REASON_RS_STOPPED,
    REASON_SITE_OUTAGE,
    REASON_STALE_HEARTBEAT,
    REASON_UNKNOWN,
    analyze_device,
)

_NOW = datetime.now(timezone.utc)


def _device(
    id=1,
    freshness_state="offline",
    last_seen=None,
    rustdesk_status="unknown",
    rustdesk_install_status="installed",
    rustdesk_last_seen_at=None,
    public_ip=None,
    local_ip=None,
    client_id=None,
    hostname="test-host",
    is_archived=False,
):
    return SimpleNamespace(
        id=id,
        freshness_state=freshness_state,
        last_seen=last_seen,
        rustdesk_status=rustdesk_status,
        rustdesk_install_status=rustdesk_install_status,
        rustdesk_last_seen_at=rustdesk_last_seen_at,
        public_ip=public_ip,
        local_ip=local_ip,
        client_id=client_id,
        hostname=hostname,
        is_archived=is_archived,
    )


# ── A: Online device ──────────────────────────────────────────────────────── #

def test_online_device_returns_null_reason():
    device = _device(freshness_state="online", last_seen=_NOW)
    result = analyze_device(device, [])
    assert result.reason is None
    assert result.confidence is None
    assert "online" in result.explanation.lower()


# ── B: No last_seen ───────────────────────────────────────────────────────── #

def test_no_last_seen_returns_unknown():
    device = _device(last_seen=None)
    result = analyze_device(device)
    assert result.reason == REASON_UNKNOWN
    assert result.confidence == CONFIDENCE_LOW
    assert result.evidence


# ── Stale device without special signals ─────────────────────────────────── #

def test_stale_device_with_ip_returns_network_lost():
    device = _device(
        freshness_state="stale",
        last_seen=_NOW - timedelta(minutes=10),
        public_ip="185.66.1.1",
    )
    result = analyze_device(device, [])
    assert result.reason == REASON_NETWORK_LOST
    assert result.confidence == CONFIDENCE_MEDIUM
    assert any("185.66.1.1" in e for e in result.evidence)


def test_stale_device_no_ip_returns_stale_heartbeat():
    device = _device(
        freshness_state="stale",
        last_seen=_NOW - timedelta(minutes=8),
    )
    result = analyze_device(device, [])
    assert result.reason == REASON_STALE_HEARTBEAT
    assert result.confidence == CONFIDENCE_LOW


# ── E: Remote Support stopped while agent recently alive ─────────────────── #

def test_rs_stopped_agent_alive_returns_rs_stopped():
    device = _device(
        freshness_state="stale",
        last_seen=_NOW - timedelta(minutes=5),     # agent seen 5m ago
        rustdesk_status="stopped",
        rustdesk_install_status="installed",
    )
    result = analyze_device(device, [])
    assert result.reason == REASON_RS_STOPPED
    assert result.confidence == CONFIDENCE_HIGH
    assert any("stopped" in e.lower() for e in result.evidence)


def test_rs_not_installed_does_not_trigger_rs_stopped():
    device = _device(
        freshness_state="stale",
        last_seen=_NOW - timedelta(minutes=5),
        rustdesk_status="stopped",
        rustdesk_install_status="not_installed",
    )
    result = analyze_device(device, [])
    # RS not installed — should NOT be REASON_RS_STOPPED
    assert result.reason != REASON_RS_STOPPED


# ── F: Agent stale while Remote Support recently active ──────────────────── #

def test_agent_stale_rs_recent_returns_agent_stopped():
    device = _device(
        freshness_state="offline",
        last_seen=_NOW - timedelta(minutes=40),         # agent stale
        rustdesk_last_seen_at=_NOW - timedelta(minutes=3),  # RS recent
        rustdesk_status="running",
    )
    result = analyze_device(device, [])
    assert result.reason == REASON_AGENT_STOPPED
    assert result.confidence == CONFIDENCE_MEDIUM
    assert len(result.evidence) >= 2


def test_agent_stale_rs_also_old_does_not_trigger_agent_stopped():
    device = _device(
        freshness_state="offline",
        last_seen=_NOW - timedelta(hours=2),
        rustdesk_last_seen_at=_NOW - timedelta(hours=2),  # both stale
    )
    result = analyze_device(device, [])
    assert result.reason != REASON_AGENT_STOPPED


# ── C: Site outage — multiple devices same client ────────────────────────── #

def test_site_outage_same_client_multiple_peers():
    t = _NOW - timedelta(minutes=20)
    device = _device(id=1, freshness_state="offline", last_seen=t, client_id=42)
    peer1 = _device(id=2, freshness_state="offline", last_seen=t + timedelta(minutes=2), client_id=42)
    peer2 = _device(id=3, freshness_state="offline", last_seen=t + timedelta(minutes=3), client_id=42)
    peer3 = _device(id=4, freshness_state="offline", last_seen=t + timedelta(minutes=1), client_id=42)

    result = analyze_device(device, [peer1, peer2, peer3])
    assert result.reason == REASON_SITE_OUTAGE
    assert result.confidence == CONFIDENCE_HIGH
    assert result.evidence


def test_site_outage_same_client_only_one_peer_does_not_trigger():
    """Two offline devices total (1 peer) should NOT trigger site outage."""
    t = _NOW - timedelta(minutes=20)
    device = _device(id=1, freshness_state="offline", last_seen=t, client_id=42)
    peer1 = _device(id=2, freshness_state="offline", last_seen=t + timedelta(minutes=1), client_id=42)

    result = analyze_device(device, [peer1])
    assert result.reason != REASON_SITE_OUTAGE


def test_site_outage_peers_outside_window_does_not_trigger():
    """Peers offline >10 minutes apart should NOT trigger site outage."""
    t_device = _NOW - timedelta(minutes=60)
    t_peer = _NOW - timedelta(minutes=10)  # 50 min gap
    device = _device(id=1, freshness_state="offline", last_seen=t_device, client_id=42)
    peers = [
        _device(id=i, freshness_state="offline", last_seen=t_peer, client_id=42)
        for i in range(2, 6)
    ]
    result = analyze_device(device, peers)
    assert result.reason != REASON_SITE_OUTAGE


# ── C: Site outage — shared public IP ────────────────────────────────────── #

def test_site_outage_same_public_ip():
    t = _NOW - timedelta(minutes=15)
    device = _device(id=1, freshness_state="offline", last_seen=t, public_ip="10.0.0.1")
    peer = _device(id=2, freshness_state="offline", last_seen=t + timedelta(minutes=2), public_ip="10.0.0.1")

    result = analyze_device(device, [peer])
    assert result.reason == REASON_SITE_OUTAGE
    assert result.confidence == CONFIDENCE_HIGH


# ── G: Single device offline (possibly powered off) ──────────────────────── #

def test_single_offline_device_from_client_returns_possibly_power_off():
    t = _NOW - timedelta(hours=1)
    device = _device(id=1, freshness_state="offline", last_seen=t, client_id=5)
    # One online peer from same client
    peer_online = _device(id=2, freshness_state="online", last_seen=_NOW, client_id=5)

    result = analyze_device(device, [peer_online])
    assert result.reason == REASON_POSSIBLY_POWER_OFF
    assert result.confidence == CONFIDENCE_LOW


def test_multiple_offline_from_same_client_does_not_return_power_off():
    t = _NOW - timedelta(hours=1)
    device = _device(id=1, freshness_state="offline", last_seen=t - timedelta(hours=2), client_id=5)
    other_offline = _device(id=2, freshness_state="offline", last_seen=t, client_id=5)

    result = analyze_device(device, [other_offline])
    # Could be network_lost or site_outage, but NOT possibly_power_off
    assert result.reason != REASON_POSSIBLY_POWER_OFF


# ── No peer context fallbacks ─────────────────────────────────────────────── #

def test_offline_with_ip_no_peers_returns_network_lost():
    device = _device(
        freshness_state="offline",
        last_seen=_NOW - timedelta(hours=2),
        public_ip="1.2.3.4",
    )
    result = analyze_device(device, [])
    assert result.reason == REASON_NETWORK_LOST
    assert result.confidence == CONFIDENCE_MEDIUM


def test_offline_no_ip_no_peers_returns_stale_heartbeat():
    device = _device(
        freshness_state="offline",
        last_seen=_NOW - timedelta(hours=2),
    )
    result = analyze_device(device, [])
    assert result.reason == REASON_STALE_HEARTBEAT


# ── Priority order sanity ─────────────────────────────────────────────────── #

def test_rs_stopped_takes_priority_over_site_outage():
    """RS stopped should be detected before checking site outage."""
    t = _NOW - timedelta(minutes=5)
    device = _device(
        id=1,
        freshness_state="stale",
        last_seen=t,
        rustdesk_status="stopped",
        rustdesk_install_status="installed",
        client_id=7,
    )
    peers = [
        _device(id=i, freshness_state="stale", last_seen=t, client_id=7)
        for i in range(2, 6)
    ]
    result = analyze_device(device, peers)
    assert result.reason == REASON_RS_STOPPED


def test_dict_serialization():
    device = _device(last_seen=_NOW - timedelta(hours=1), public_ip="5.5.5.5")
    result = analyze_device(device)
    d = result.as_dict()
    assert "reason" in d
    assert "confidence" in d
    assert "explanation" in d
    assert isinstance(d["evidence"], list)
