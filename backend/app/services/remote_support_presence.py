"""Remote Support identity from the client itself.

Every TECHI Remote Support (RustDesk) client whose api-server is the platform
posts to it, from its own service (rustdesk src/hbbs_http/sync.rs):

- ``POST /api/heartbeat`` every 15 s (every 3 s during a session):
  ``{"id": "1529551896", "uuid": "<base64 MachineGuid>", "ver": …, "modified_at": …}``
- ``POST /api/sysinfo`` when its system info changes:
  ``{"id", "uuid", "hostname", "username", "os", "cpu", "memory", "version"}``,
  until the server answers ``SYSINFO_UPDATED``.

The id is the one in the client's window, so it is the truth about the
device's Remote Support ID; the uuid (MachineGuid) ties it to one machine.
Until now these posts were taken for legacy agent heartbeats and dropped, so
an ID that changed on the device (reinstall, a new client generation, the ID
server reassigning it) stayed wrong on the platform for as long as the agent
kept reading an old config file.

What happens with a report:

1. Fast path, no database: the client is known, its ID and address unchanged.
   The time is noted in memory and written in one batch a minute (``flush``).
2. Otherwise the report is stored (``remote_support_peers``) and bound to a
   device: by MachineGuid (agents >= 2.1.34 send it), by the same ID, or by
   hostname reported by the client and the device's public IP, both unique.
3. A bound client whose ID differs from its device's corrects the device —
   unless an operator pinned the ID, the address does not match (a hostname
   binding), or the old ID is still reporting from the same MachineGuid (a
   cloned machine, not a changed ID). An ID still held by another live device
   is a conflict, shown on both; one held by an archived, trashed or long
   silent device is released.

Never answered to a client: "strategy" or "disconnect" (they would change its
configuration or drop sessions). The heartbeat answer is {} or, when the
platform has no system info for it yet, {"sysinfo": 1}.
"""
from __future__ import annotations

import base64
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Optional, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.time import utcnow_naive
from app.models.device import Device
from app.models.remote_support_peer import RemoteSupportPeer

logger = logging.getLogger("techi.remote_support_presence")

# The agent's own ID report gives way to the client's while the client has
# reported this recently.
TRUST_WINDOW = timedelta(minutes=30)
# The ID server sync runs every 5 minutes and refreshes verified_at every 6 h.
ID_SERVER_TRUST = timedelta(hours=7)
# Another device holding the ID is released when silent this long.
RELEASE_AFTER = timedelta(days=7)
# In-memory "last seen" is written at most this often per client.
FLUSH_EVERY_S = 60
# Cap on clients kept in memory (the fleet is ~1,000).
CACHE_MAX = 20_000

_GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _naive(value: datetime) -> datetime:
    """Naive UTC (the columns' form) from naive or aware UTC."""
    from datetime import timezone

    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def normalize_id(value) -> Optional[str]:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits if 5 <= len(digits) <= 20 else None


def normalize_guid(value: Optional[str]) -> Optional[str]:
    text = (value or "").strip().strip("{}")
    return text.lower() if _GUID.match(text) else None


def guid_from_uuid(uuid: str) -> Optional[str]:
    """Remote Support's uuid is base64 of machine_uid::get(), which on Windows
    is the MachineGuid string."""
    try:
        raw = base64.b64decode(uuid + "=" * (-len(uuid) % 4), validate=False)
        return normalize_guid(raw.decode("utf-8", errors="strict"))
    except (ValueError, UnicodeDecodeError):
        return None


@dataclass
class _Seen:
    peer_id: int
    rustdesk_id: str
    device_id: Optional[int]
    source_ip: Optional[str]
    needs_sysinfo: bool
    seen_at: datetime
    flushed_at: float


class _Cache:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.items: Dict[Tuple[str, str], _Seen] = {}
        self.dirty: Dict[Tuple[str, str], _Seen] = {}

    def get(self, key):
        with self.lock:
            return self.items.get(key)

    def put(self, key, entry: _Seen) -> None:
        with self.lock:
            if len(self.items) >= CACHE_MAX and key not in self.items:
                self.items.pop(next(iter(self.items)))
            self.items[key] = entry

    def touch(self, key, entry: _Seen, now: datetime) -> None:
        with self.lock:
            entry.seen_at = now
            self.dirty[key] = entry

    def take_dirty(self) -> Dict[Tuple[str, str], _Seen]:
        with self.lock:
            dirty, self.dirty = self.dirty, {}
            return dirty

    def clear(self) -> None:
        with self.lock:
            self.items.clear()
            self.dirty.clear()


CACHE = _Cache()


def parse_report(body) -> Optional[Tuple[str, str]]:
    """(rustdesk_id, uuid) when the body is a Remote Support report."""
    if not isinstance(body, dict):
        return None
    uuid = body.get("uuid")
    rustdesk_id = normalize_id(body.get("id"))
    if not isinstance(uuid, str) or not (8 <= len(uuid) <= 128) or rustdesk_id is None:
        return None
    return rustdesk_id, uuid


def is_remote_support_report(body) -> bool:
    """Remote Support's heartbeat, not an agent's: it has a uuid and an id and
    none of the agent's identity fields."""
    if parse_report(body) is None:
        return False
    return not any(key in body for key in ("agent_id", "device_id", "hostname", "rustdesk_id"))


class RemoteSupportPresence:
    def __init__(self, db: Session):
        self.db = db

    # ── the two endpoints ───────────────────────────────────────────────────

    @staticmethod
    def fast_heartbeat(rustdesk_id: str, uuid: str, source_ip: Optional[str]) -> Optional[dict]:
        """The answer without the database, or None when it needs it."""
        entry = CACHE.get((uuid, rustdesk_id))
        if entry is None or entry.source_ip != source_ip:
            return None
        CACHE.touch((uuid, rustdesk_id), entry, utcnow_naive())
        return {"sysinfo": 1} if entry.needs_sysinfo else {}

    def heartbeat(self, rustdesk_id: str, uuid: str, source_ip: Optional[str], version=None) -> dict:
        now = utcnow_naive()
        peer, created = self._peer(rustdesk_id, uuid, source_ip, now)
        if version is not None and isinstance(version, int):
            peer.version = peer.version or str(version)
        self._settle(peer, now)
        self.db.commit()
        self._cache(peer)
        return {"sysinfo": 1} if peer.sysinfo_at is None else {}

    def sysinfo(self, body: dict, source_ip: Optional[str]) -> str:
        report = parse_report(body)
        if report is None:
            return ""
        rustdesk_id, uuid = report
        now = utcnow_naive()
        peer, _ = self._peer(rustdesk_id, uuid, source_ip, now)

        def text(key: str, limit: int) -> Optional[str]:
            value = body.get(key)
            return str(value).strip()[:limit] or None if value is not None else None

        peer.hostname = text("hostname", 255) or peer.hostname
        peer.username = text("username", 255) or peer.username
        peer.os = text("os", 255) or peer.os
        peer.version = text("version", 32) or peer.version
        peer.sysinfo_at = now
        self._settle(peer, now)
        self.db.commit()
        self._cache(peer)
        return "SYSINFO_UPDATED"

    # ── storing and binding ─────────────────────────────────────────────────

    def _peer(self, rustdesk_id: str, uuid: str, source_ip: Optional[str], now: datetime):
        peer = (
            self.db.query(RemoteSupportPeer)
            .filter(RemoteSupportPeer.uuid == uuid, RemoteSupportPeer.rustdesk_id == rustdesk_id)
            .first()
        )
        created = peer is None
        if created:
            peer = RemoteSupportPeer(
                uuid=uuid, rustdesk_id=rustdesk_id, machine_guid=guid_from_uuid(uuid),
                first_seen_at=now, last_seen_at=now, source_ip=source_ip,
            )
            self.db.add(peer)
            self.db.flush()
        peer.last_seen_at = now
        if source_ip:
            peer.source_ip = source_ip[:64]
        return peer, created

    def _settle(self, peer: RemoteSupportPeer, now: datetime) -> None:
        device = self.db.get(Device, peer.device_id) if peer.device_id else None
        if device is not None and (device.deleted_at is not None):
            peer.device_id, peer.bound_by, device = None, None, None
        if device is None:
            device = self._bind(peer, now)
        if device is None:
            return
        device.rustdesk_presence_at = now
        self.apply(peer, device, now)

    def _bind(self, peer: RemoteSupportPeer, now: datetime) -> Optional[Device]:
        live = self.db.query(Device).filter(Device.deleted_at.is_(None))
        # 1. The MachineGuid the device's agent reports.
        if peer.machine_guid:
            matches = live.filter(Device.machine_guid == peer.machine_guid).limit(2).all()
            if len(matches) == 1:
                return self._attach(peer, matches[0], "machine_guid", now)
        # 2. The same machine, already bound under another ID (the ID changed).
        sibling = (
            self.db.query(RemoteSupportPeer)
            .filter(RemoteSupportPeer.uuid == peer.uuid, RemoteSupportPeer.id != peer.id,
                    RemoteSupportPeer.device_id.isnot(None))
            .order_by(RemoteSupportPeer.last_seen_at.desc())
            .first()
        )
        if sibling is not None:
            device = self.db.get(Device, sibling.device_id)
            if device is not None and device.deleted_at is None:
                return self._attach(peer, device, "same_machine", now)
        # 3. The same ID the device already has — unless its agent reports
        #    another MachineGuid (a cloned machine using the ID).
        same = live.filter(Device.rustdesk_id == peer.rustdesk_id).first()
        if same is not None and (not same.machine_guid or not peer.machine_guid or same.machine_guid == peer.machine_guid):
            return self._attach(peer, same, "id_match", now)
        # 4. The hostname the client reports, at the device's public address.
        if peer.hostname and peer.source_ip:
            matches = (
                live.filter(Device.hostname.ilike(peer.hostname), Device.public_ip == peer.source_ip)
                .limit(2)
                .all()
            )
            if len(matches) == 1 and (not matches[0].machine_guid or not peer.machine_guid
                                      or matches[0].machine_guid == peer.machine_guid):
                return self._attach(peer, matches[0], "hostname_ip", now)
        return None

    def _attach(self, peer: RemoteSupportPeer, device: Device, how: str, now: datetime) -> Device:
        peer.device_id = device.id
        peer.bound_by = how
        peer.bound_at = now
        peer.note = None
        return device

    def apply(self, peer: RemoteSupportPeer, device: Device, now: datetime) -> bool:
        """Make the device's ID the client's own. Returns True when it changed."""
        if device.rustdesk_id == peer.rustdesk_id:
            device.rustdesk_id_source = "remote_support"
            device.rustdesk_verified_at = now
            if device.rustdesk_sync_state != "synced" and not device.rustdesk_conflict_detected:
                device.rustdesk_sync_state = "synced"
                device.rustdesk_sync_message = None
            peer.note = None
            return False
        if device.rustdesk_manual_override:
            peer.note = "The device's ID is pinned by an operator"
            return False
        if peer.bound_by == "hostname_ip" and (device.public_ip or "") != (peer.source_ip or ""):
            peer.note = "Bound by hostname; the address no longer matches"
            return False
        if device.rustdesk_id and self._reported_after(peer.uuid, device.rustdesk_id, peer.first_seen_at):
            # The same MachineGuid reports both IDs: two machines from one image.
            peer.note = f"Cloned machine: {device.rustdesk_id} reports from the same MachineGuid"
            if device.agent_rustdesk_id == peer.rustdesk_id:
                # The device's own agent reads this one: it is this device's.
                device.rustdesk_id = peer.rustdesk_id
            device.rustdesk_conflict_detected = True
            device.rustdesk_sync_state = "failed"
            device.rustdesk_sync_message = (
                f"Two machines share this MachineGuid: {device.rustdesk_id} and {peer.rustdesk_id}. "
                "Run sysprep or regenerate the MachineGuid on the copy."
            )[:255]
            return False
        holder = (
            self.db.query(Device)
            .filter(Device.rustdesk_id == peer.rustdesk_id, Device.id != device.id)
            .first()
        )
        if holder is not None:
            if not self._releasable(holder, now):
                peer.note = f"ID also held by device #{holder.id}"
                device.rustdesk_conflict_detected = True
                device.rustdesk_sync_state = "failed"
                device.rustdesk_sync_message = (
                    f"Remote Support reports {peer.rustdesk_id}, which device #{holder.id} "
                    f"({holder.display_name or holder.hostname}) also uses"
                )[:255]
                return False
            self._release(holder, peer.rustdesk_id, device)
        old = device.rustdesk_id
        device.rustdesk_id = peer.rustdesk_id
        device.rustdesk_id_source = "remote_support"
        device.rustdesk_verified_at = now
        device.rustdesk_synced_at = now
        device.rustdesk_sync_state = "synced"
        device.rustdesk_sync_message = None
        device.rustdesk_conflict_detected = False
        peer.note = None
        self.db.flush()
        self._record_change(device, old, peer)
        return True

    def _reported_after(self, uuid: str, rustdesk_id: str, since: datetime) -> bool:
        """Whether the same MachineGuid still reported this other ID after
        ``since``. An ID that changed goes quiet when the new one appears; a
        cloned machine keeps reporting its own."""
        last = None
        other = CACHE.get((uuid, rustdesk_id))
        if other is not None:
            last = other.seen_at
        row = (
            self.db.query(RemoteSupportPeer.last_seen_at)
            .filter(RemoteSupportPeer.uuid == uuid, RemoteSupportPeer.rustdesk_id == rustdesk_id)
            .first()
        )
        if row is not None and (last is None or row[0] > last):
            last = row[0]
        return last is not None and last > since + timedelta(seconds=30)

    @staticmethod
    def _releasable(holder: Device, now: datetime) -> bool:
        if holder.is_archived or holder.deleted_at is not None:
            return True
        seen = max(filter(None, [holder.last_seen, holder.rustdesk_presence_at]), default=None)
        return seen is None or now - seen > RELEASE_AFTER

    def _release(self, holder: Device, rustdesk_id: str, taker: Device) -> None:
        holder.rustdesk_id = None
        holder.rustdesk_id_source = None
        holder.rustdesk_sync_message = f"ID {rustdesk_id} moved to device #{taker.id}"[:255]
        self.db.flush()
        self._audit("remote_support_id_released", holder.id, {"rustdesk_id": rustdesk_id, "to_device_id": taker.id})

    def _record_change(self, device: Device, old: Optional[str], peer: RemoteSupportPeer) -> None:
        how = {"machine_guid": "MachineGuid", "same_machine": "the same machine", "id_match": "its ID",
               "id_server": "the ID server's registration",
               "hostname_ip": "hostname and address",
               "manual": "an operator"}.get(peer.bound_by or "", "its report")
        logger.warning("Remote Support ID of device %s: %s -> %s (the client's own report, bound by %s)",
                       device.id, old, peer.rustdesk_id, peer.bound_by)
        try:
            from app.services.device_activity_event_service import DeviceActivityEventService

            DeviceActivityEventService(self.db).record(
                device_id=device.id,
                event_type="remote_support_id_changed",
                summary=f"Remote Support ID {old or '—'} → {peer.rustdesk_id}",
                detail=(f"Registered by this machine on the ID server ({how})." if peer.bound_by == "id_server"
                        else f"Reported by TECHI Remote Support itself (matched by {how})."),
                actor="remote_support",
                fail_silently=True,
            )
        except Exception:
            logger.debug("activity event failed", exc_info=True)
        self._audit("remote_support_id_changed", device.id,
                    {"from": old, "to": peer.rustdesk_id, "bound_by": peer.bound_by, "source_ip": peer.source_ip})
        try:
            from app.websocket.events import RealtimeEventType, build_event, device_payload
            from app.websocket.publisher import realtime_publisher

            realtime_publisher.publish_threadsafe(
                build_event(RealtimeEventType.RUSTDESK_UPDATED, data=device_payload(device), reason="remote_support_id_changed"),
                dedupe_key=f"rustdesk_id:{device.id}:{device.rustdesk_id}",
            )
        except Exception:
            logger.debug("realtime publish failed", exc_info=True)

    def _audit(self, action: str, device_id: int, details: dict) -> None:
        from app.services.audit_service import system_audit_log

        system_audit_log(self.db, action=action, entity_type="device", entity_id=device_id, details=details)

    @staticmethod
    def _cache(peer: RemoteSupportPeer) -> None:
        CACHE.put(
            (peer.uuid, peer.rustdesk_id),
            _Seen(peer_id=peer.id, rustdesk_id=peer.rustdesk_id, device_id=peer.device_id, source_ip=peer.source_ip,
                  needs_sysinfo=peer.sysinfo_at is None, seen_at=peer.last_seen_at, flushed_at=time.monotonic()),
        )

    # ── the agent's report gives way ────────────────────────────────────────

    @staticmethod
    def client_is_authority(device: Device, now: Optional[datetime] = None) -> bool:
        """Whether the client's own recent report decides the device's ID, so
        the agent's (from config files) must not overwrite it."""
        now = _naive(now or utcnow_naive())
        source = getattr(device, "rustdesk_id_source", None)
        presence = getattr(device, "rustdesk_presence_at", None)
        if source == "remote_support" and presence is not None:
            return now - _naive(presence) <= TRUST_WINDOW
        # The ID server's word (app/services/hbbs_sync.py) holds against an
        # agent that cannot name its machine (< 2.1.34: it reports the ID it
        # was enrolled with between probes). An agent that sends its
        # MachineGuid reads the client fresh and is verified by the sync.
        verified = getattr(device, "rustdesk_verified_at", None)
        if source == "id_server" and verified is not None and not getattr(device, "machine_guid", None):
            return now - _naive(verified) <= ID_SERVER_TRUST
        return False

    # ── operator binding ────────────────────────────────────────────────────

    def bind_manually(self, peer: RemoteSupportPeer, device: Device, operator_username: str) -> bool:
        now = utcnow_naive()
        self._attach(peer, device, "manual", now)
        changed = self.apply(peer, device, now)
        device.rustdesk_presence_at = peer.last_seen_at
        self.db.commit()
        self._cache(peer)
        self._audit("remote_support_peer_bound", device.id,
                    {"peer_id": peer.id, "rustdesk_id": peer.rustdesk_id, "by": operator_username})
        return changed


def flush(db: Session) -> int:
    """Write the "last seen" times noted in memory, in one go."""
    dirty = CACHE.take_dirty()
    if not dirty:
        return 0
    peer_rows = [{"pid": e.peer_id, "seen": e.seen_at} for e in dirty.values()]
    device_rows: Dict[int, datetime] = {}
    for entry in dirty.values():
        if entry.device_id is not None:
            device_rows[entry.device_id] = max(entry.seen_at, device_rows.get(entry.device_id, entry.seen_at))
    from sqlalchemy import bindparam

    peers = RemoteSupportPeer.__table__
    devices = Device.__table__
    db.execute(peers.update().where(peers.c.id == bindparam("pid")).values(last_seen_at=bindparam("seen")), peer_rows)
    if device_rows:
        db.execute(
            devices.update().where(devices.c.id == bindparam("did")).values(rustdesk_presence_at=bindparam("seen")),
            [{"did": k, "seen": v} for k, v in device_rows.items()],
        )
    db.commit()
    return len(peer_rows)


def presence_summary(db: Session) -> dict:
    """Numbers for the Remote Support IDs view."""
    now = utcnow_naive()
    day = now - timedelta(hours=24)
    week = now - timedelta(days=7)
    live = db.query(Device).filter(Device.deleted_at.is_(None), Device.is_archived.is_(False))
    with_id = live.filter(Device.rustdesk_id.isnot(None)).count()
    confirmed = live.filter(
        Device.rustdesk_id_source.in_(("remote_support", "id_server")), Device.rustdesk_verified_at >= day
    ).count()
    unbound = db.query(RemoteSupportPeer).filter(RemoteSupportPeer.device_id.is_(None),
                                                 RemoteSupportPeer.last_seen_at >= week).count()
    attention = live.filter(or_(Device.rustdesk_conflict_detected.is_(True),
                                Device.rustdesk_sync_message.like("%cloned machines%"))).count()
    disagree = live.filter(Device.agent_rustdesk_id.isnot(None),
                           or_(Device.rustdesk_id.is_(None), Device.agent_rustdesk_id != Device.rustdesk_id)).count()
    return {"devices_with_id": with_id, "confirmed_24h": confirmed, "unbound_clients_24h": unbound,
            "attention_24h": attention, "agent_disagrees": disagree}
