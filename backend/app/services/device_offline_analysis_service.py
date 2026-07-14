"""
Device Offline Analysis Service.

Infers the most likely reason a device is stale/offline from existing
heartbeat, telemetry, and fleet data.  No agent changes required.
"""

from dataclasses import dataclass, field
from datetime import timedelta
from typing import List, Optional

from app.core.time import ensure_utc, utcnow

# ── Freshness thresholds (mirror device model) ──────────────────────────── #
_ONLINE_MAX = timedelta(minutes=6)
_STALE_MAX = timedelta(minutes=25)

# How long after the device's last_seen do we still consider the agent
# "recently" active for rule evaluation purposes.
_AGENT_RECENTLY_ALIVE = timedelta(minutes=30)

# Window within which two devices "going offline at the same time" counts
# as a site-outage signal.
_SITE_OUTAGE_WINDOW = timedelta(minutes=10)

# Minimum number of peer devices that must also be offline for us to declare
# a site outage (excluding the device under analysis).
_SITE_OUTAGE_MIN_PEERS = 2

# ── Reason constants ────────────────────────────────────────────────────── #
REASON_SITE_OUTAGE = "site_outage"
REASON_NETWORK_LOST = "network_lost"
REASON_AGENT_STOPPED = "agent_stopped"
REASON_RS_STOPPED = "remote_support_stopped"
REASON_STALE_HEARTBEAT = "stale_heartbeat"
REASON_POSSIBLY_POWER_OFF = "possibly_power_off"
REASON_UNKNOWN = "unknown"

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"
CONFIDENCE_LOW = "low"


@dataclass
class DeviceOfflineAnalysis:
    reason: Optional[str]
    confidence: Optional[str]
    explanation: str
    evidence: List[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "reason": self.reason,
            "confidence": self.confidence,
            "explanation": self.explanation,
            "evidence": self.evidence,
        }


def _age_label(dt) -> str:
    """Human-readable age from a datetime, e.g. '3m ago'."""
    if not dt:
        return "unknown time ago"
    age = utcnow() - ensure_utc(dt)
    minutes = int(age.total_seconds() / 60)
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h ago"
    return f"{hours // 24}d ago"


def analyze_device(
    device,
    peer_devices: Optional[List] = None,
) -> DeviceOfflineAnalysis:
    """
    Compute offline analysis for *device*.

    Parameters
    ----------
    device
        Any object with the Device model attributes (SQLAlchemy row or mock).
    peer_devices
        Optional list of other Device objects in the same fleet.  Used for
        site-outage detection.  Pass None or [] to skip fleet-level checks.
    """
    now = utcnow()
    freshness = getattr(device, "freshness_state", None)
    last_seen = getattr(device, "last_seen", None)
    peers = peer_devices or []

    # ── A: Device is online ──────────────────────────────────────────────── #
    if freshness == "online":
        return DeviceOfflineAnalysis(
            reason=None,
            confidence=None,
            explanation="Device is currently online.",
        )

    # ── B: No last_seen data at all ──────────────────────────────────────── #
    if last_seen is None:
        return DeviceOfflineAnalysis(
            reason=REASON_UNKNOWN,
            confidence=CONFIDENCE_LOW,
            explanation="No recent heartbeat data is available.",
            evidence=["Device has never checked in or heartbeat data is missing."],
        )

    last_seen_aware = ensure_utc(last_seen)
    last_seen_age = now - last_seen_aware

    # ── E: Remote Support stopped while agent recently alive ─────────────── #
    rs_status = (getattr(device, "rustdesk_status", "") or "").lower()
    raw_rs_state = getattr(device, "remote_support_state", None)
    if raw_rs_state is None:
        rs_install = (getattr(device, "rustdesk_install_status", "") or "").lower()
        if rs_install not in {"not_installed", "not installed", "unknown", ""} and rs_status in {
            "stopped",
            "not_running",
            "not running",
            "offline",
        }:
            raw_rs_state = "installed_stopped"
    rs_state = (raw_rs_state or "unknown").lower()
    rs_stopped = rs_state == "installed_stopped"
    rs_installed = rs_state in {"installed_stopped", "installed_running", "healthy"}

    if rs_stopped and rs_installed and last_seen_age < _AGENT_RECENTLY_ALIVE:
        evidence = [
            f"TECHI Remote Support status: {rs_status}",
            f"Agent last seen: {_age_label(last_seen)}",
        ]
        return DeviceOfflineAnalysis(
            reason=REASON_RS_STOPPED,
            confidence=CONFIDENCE_HIGH,
            explanation="Agent is alive, but TECHI Remote Support service is not running.",
            evidence=evidence,
        )

    # ── F: Agent stale while Remote Support was recently active ─────────── #
    rs_last_seen = getattr(device, "rustdesk_last_seen_at", None)
    if rs_last_seen is not None:
        rs_age = now - ensure_utc(rs_last_seen)
        if rs_age < _STALE_MAX and last_seen_age >= _STALE_MAX:
            evidence = [
                f"Remote Support last seen: {_age_label(rs_last_seen)}",
                f"Agent heartbeat: {_age_label(last_seen)}",
            ]
            return DeviceOfflineAnalysis(
                reason=REASON_AGENT_STOPPED,
                confidence=CONFIDENCE_MEDIUM,
                explanation="Remote Support appears available but the TECHI Agent stopped sending heartbeats.",
                evidence=evidence,
            )

    # ── C/D: Site-outage detection (requires peer context) ───────────────── #
    client_id = getattr(device, "client_id", None)
    public_ip = getattr(device, "public_ip", None)

    if peers:
        # Check same client_id
        if client_id:
            client_peers_offline = [
                p for p in peers
                if getattr(p, "id", None) != device.id
                and getattr(p, "client_id", None) == client_id
                and getattr(p, "freshness_state", "offline") in ("stale", "offline")
                and getattr(p, "last_seen", None) is not None
                and abs(
                    (ensure_utc(p.last_seen) - last_seen_aware).total_seconds()
                ) <= _SITE_OUTAGE_WINDOW.total_seconds()
            ]
            if len(client_peers_offline) >= _SITE_OUTAGE_MIN_PEERS:
                hostnames = ", ".join(
                    getattr(p, "hostname", f"#{getattr(p, 'id', '?')}")
                    for p in client_peers_offline[:4]
                )
                evidence = [
                    f"{len(client_peers_offline)} other device(s) from the same client went offline "
                    f"within {int(_SITE_OUTAGE_WINDOW.total_seconds() / 60)} minutes: {hostnames}",
                ]
                return DeviceOfflineAnalysis(
                    reason=REASON_SITE_OUTAGE,
                    confidence=CONFIDENCE_HIGH,
                    explanation="Multiple devices from the same client/site went offline around the same time.",
                    evidence=evidence,
                )

        # Check same public IP (cross-client LAN/router failure)
        if public_ip:
            ip_peers_offline = [
                p for p in peers
                if getattr(p, "id", None) != device.id
                and getattr(p, "public_ip", None) == public_ip
                and getattr(p, "freshness_state", "offline") in ("stale", "offline")
                and getattr(p, "last_seen", None) is not None
                and abs(
                    (ensure_utc(p.last_seen) - last_seen_aware).total_seconds()
                ) <= _SITE_OUTAGE_WINDOW.total_seconds()
            ]
            if ip_peers_offline:
                evidence = [
                    f"{len(ip_peers_offline)} device(s) sharing the same public IP "
                    f"({public_ip}) also went offline in the same window.",
                ]
                return DeviceOfflineAnalysis(
                    reason=REASON_SITE_OUTAGE,
                    confidence=CONFIDENCE_HIGH,
                    explanation="Multiple devices from the same site (shared public IP) went offline around the same time.",
                    evidence=evidence,
                )

    # ── G: Single device offline from its client (possibly powered off) ─── #
    if freshness == "offline" and peers and client_id:
        other_offline = [
            p for p in peers
            if getattr(p, "id", None) != device.id
            and getattr(p, "client_id", None) == client_id
            and getattr(p, "freshness_state", "offline") == "offline"
        ]
        if not other_offline:
            evidence: List[str] = ["No other devices from this client are currently offline."]
            if public_ip:
                evidence.append(f"Last known public IP: {public_ip}")
            local_ip = getattr(device, "local_ip", None)
            if local_ip:
                evidence.append(f"Last known local IP: {local_ip}")
            return DeviceOfflineAnalysis(
                reason=REASON_POSSIBLY_POWER_OFF,
                confidence=CONFIDENCE_LOW,
                explanation="Only this device is offline; it may be powered off or disconnected.",
                evidence=evidence,
            )

    # ── D: Network lost (device has IP info but no other signal) ─────────── #
    local_ip = getattr(device, "local_ip", None)
    if public_ip or local_ip:
        evidence = []
        if public_ip:
            evidence.append(f"Last known public IP: {public_ip}")
        if local_ip:
            evidence.append(f"Last known local IP: {local_ip}")
        evidence.append(f"Last heartbeat: {_age_label(last_seen)}")
        return DeviceOfflineAnalysis(
            reason=REASON_NETWORK_LOST,
            confidence=CONFIDENCE_MEDIUM,
            explanation="Device stopped sending heartbeats. Last known network identity is available.",
            evidence=evidence,
        )

    # ── Fallback: stale heartbeat ─────────────────────────────────────────── #
    return DeviceOfflineAnalysis(
        reason=REASON_STALE_HEARTBEAT,
        confidence=CONFIDENCE_LOW,
        explanation="Device heartbeats have become infrequent or stopped.",
        evidence=[f"Last heartbeat: {_age_label(last_seen)}"],
    )
