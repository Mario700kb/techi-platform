"""Remote Support IDs from the ID server itself (hbbs).

Every TECHI Remote Support client registers with the platform's own ID
server (hbbs, on the same host): its ID together with its uuid, which is the
machine's MachineGuid. hbbs keeps one row per (ID, machine) in
``db_v2.sqlite3`` table ``peer`` (id, uuid, created_at, info {"ip"}). Unlike
the clients' own /api/heartbeat (which the 1.4.6 clients in the fleet do not
send), this covers every client, so it is the platform's ground truth:

- A device whose agent reports its MachineGuid (agents >= 2.1.34) is matched
  to its machine exactly; the agent's ID is verified when hbbs holds it for
  that MachineGuid, and a stale platform ID is replaced by it.
- A device known only by its ID (older agents) is matched to the machine that
  registered that ID. When the machine registered exactly one newer ID since,
  and nothing else uses it, the device's ID is corrected to it.
- A MachineGuid that registered several IDs close together keeps taking new
  IDs. Mostly because the client could not save its key pair (agents before
  2.1.35 left its identity file read-only): with a new key from another
  address, the ID server refuses its ID ("ip/pk mismatch") and it picks a new
  one at every restart. Otherwise cloned machines share the MachineGuid.
  Those are explained on the device, not "corrected".

The database is read from a read-only mount; it is copied (with its WAL)
before reading, so hbbs is never locked and recent changes are seen. Rows land
in remote_support_peers (bound_by "id_server"), which the Remote Support IDs
view lists.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import shutil
import sqlite3
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.time import utcnow_naive
from app.models.device import Device
from app.models.remote_support_peer import RemoteSupportPeer
from app.services.remote_support_presence import RemoteSupportPresence, _naive, normalize_guid, normalize_id

logger = logging.getLogger("techi.hbbs_sync")

# IDs a MachineGuid registered within this long of each other, more than
# two of them: cloned machines fighting over IDs.
CLONE_BURST = timedelta(days=2)
CLONE_MIN_IDS = 3
VERIFIED_REFRESH = timedelta(hours=6)


@dataclass(frozen=True)
class HbbsPeer:
    rustdesk_id: str
    uuid_b64: str
    machine_guid: Optional[str]
    created_at: datetime
    ip: Optional[str]


def _ip(info: Optional[str]) -> Optional[str]:
    try:
        value = json.loads(info or "{}").get("ip")
    except ValueError:
        return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[7:] if value.startswith("::ffff:") else value or None


def read_hbbs(path: str) -> List[HbbsPeer]:
    """Every (ID, machine) the ID server knows. Copies the database first."""
    if not path or not os.path.exists(path):
        return []
    with tempfile.TemporaryDirectory(prefix="hbbs-") as tmp:
        copy = os.path.join(tmp, "db.sqlite3")
        shutil.copyfile(path, copy)
        for suffix in ("-wal", "-shm"):
            if os.path.exists(path + suffix):
                shutil.copyfile(path + suffix, copy + suffix)
        conn = sqlite3.connect(copy, timeout=5)
        try:
            rows = conn.execute("SELECT id, uuid, created_at, info FROM peer").fetchall()
        finally:
            conn.close()
    out: List[HbbsPeer] = []
    for rustdesk_id, uuid, created_at, info in rows:
        rid = normalize_id(rustdesk_id)
        if rid is None or not uuid:
            continue
        raw = bytes(uuid) if not isinstance(uuid, bytes) else uuid
        try:
            guid = normalize_guid(raw.decode("ascii"))
        except UnicodeDecodeError:
            guid = None
        try:
            created = datetime.fromisoformat(str(created_at).replace("T", " ").split(".")[0])
        except ValueError:
            created = utcnow_naive()
        out.append(HbbsPeer(rid, base64.b64encode(raw).decode()[:128], guid, created, _ip(info)))
    return out


def clone_groups(peers: List[HbbsPeer]) -> Dict[str, List[HbbsPeer]]:
    """MachineGuids that registered several IDs in a short time."""
    by_machine: Dict[str, List[HbbsPeer]] = defaultdict(list)
    for peer in peers:
        by_machine[peer.uuid_b64].append(peer)
    groups = {}
    for key, items in by_machine.items():
        items = sorted(items, key=lambda p: p.created_at)
        for i in range(len(items)):
            window = [p for p in items[i:] if p.created_at - items[i].created_at <= CLONE_BURST]
            if len(window) >= CLONE_MIN_IDS:
                groups[key] = items
                break
    return groups


class HbbsSync:
    def __init__(self, db: Session):
        self.db = db
        self.presence = RemoteSupportPresence(db)

    def run(self, peers: Optional[List[HbbsPeer]] = None) -> dict:
        if peers is None:
            peers = read_hbbs(settings.HBBS_DB_PATH)
        if not peers:
            return {"peers": 0}
        now = utcnow_naive()
        rows = self._store(peers)
        clones = clone_groups(peers)
        by_id = {p.rustdesk_id: p for p in peers}
        by_machine: Dict[str, List[HbbsPeer]] = defaultdict(list)
        for p in peers:
            by_machine[p.uuid_b64].append(p)
        guid_key = {}
        for key, items in by_machine.items():
            if items[0].machine_guid:
                guid_key.setdefault(items[0].machine_guid, key)
        self._guid_key = guid_key
        corrected = verified = flagged = 0
        devices = (
            self.db.query(Device)
            .filter(Device.deleted_at.is_(None), Device.is_archived.is_(False))
            .filter((Device.rustdesk_id.isnot(None)) | (Device.machine_guid.isnot(None)))
            .all()
        )
        for device in devices:
            result = self._judge(device, by_id, by_machine, clones, rows, now)
            corrected += result == "corrected"
            verified += result in ("verified", "corrected")
            flagged += result == "clone"
        self.db.commit()
        summary = {"peers": len(peers), "machines": len(by_machine), "clone_groups": len(clones),
                   "verified": verified, "corrected": corrected, "clones": flagged}
        logger.info("hbbs sync: %s", summary)
        return summary

    # ── storing ─────────────────────────────────────────────────────────────

    def _store(self, peers: List[HbbsPeer]) -> Dict[tuple, RemoteSupportPeer]:
        existing = {(r.uuid, r.rustdesk_id): r for r in self.db.query(RemoteSupportPeer).all()}
        for p in peers:
            row = existing.get((p.uuid_b64, p.rustdesk_id))
            if row is None:
                row = RemoteSupportPeer(
                    uuid=p.uuid_b64, rustdesk_id=p.rustdesk_id, machine_guid=p.machine_guid,
                    source_ip=p.ip, first_seen_at=p.created_at, last_seen_at=p.created_at,
                )
                self.db.add(row)
                existing[(p.uuid_b64, p.rustdesk_id)] = row
            else:
                if p.ip and row.source_ip != p.ip:
                    row.source_ip = p.ip
                if row.last_seen_at is None or row.last_seen_at < p.created_at:
                    row.last_seen_at = p.created_at
        self.db.flush()
        return existing

    # ── judging one device ──────────────────────────────────────────────────

    def _judge(self, device: Device, by_id, by_machine, clones, rows, now) -> str:
        current = by_id.get(device.rustdesk_id) if device.rustdesk_id else None
        machine_key = None
        if device.machine_guid:
            machine_key = self._guid_key.get(device.machine_guid)
        if machine_key is None and current is not None:
            machine_key = current.uuid_b64
        if machine_key is None:
            return "unknown"
        ids = sorted(by_machine[machine_key], key=lambda p: p.created_at)
        for p in ids:
            row = rows.get((p.uuid_b64, p.rustdesk_id))
            if row is not None and row.device_id is None:
                row.device_id, row.bound_by, row.bound_at = device.id, "id_server", now

        if machine_key in clones:
            text = (f"Remote Support keeps taking new IDs: {len(ids)} registered by this machine "
                    f"({', '.join(p.rustdesk_id for p in ids[-4:])}). Usually it cannot save its identity "
                    "(agents before 2.1.35 left its file read-only); if it goes on after the update, "
                    "cloned machines share this MachineGuid (run sysprep on the copies).")
            for p in ids:
                row = rows.get((p.uuid_b64, p.rustdesk_id))
                if row is not None:
                    row.note = "IDs keep changing: identity not saved, or cloned machines"
            # The agent's fresh reading tells which of the IDs this device has.
            agent_id = device.agent_rustdesk_id
            if device.machine_guid and agent_id and any(p.rustdesk_id == agent_id for p in ids):
                self._apply(device, agent_id, rows, now, by_id)
            if device.rustdesk_sync_message != text[:255]:
                device.rustdesk_sync_message = text[:255]
            return "clone"

        target: Optional[str] = None
        if device.machine_guid:
            # Exact machine: the agent's own reading, if the ID server agrees.
            agent_id = device.agent_rustdesk_id
            if agent_id and any(p.rustdesk_id == agent_id for p in ids):
                target = agent_id
            elif len(ids) == 1:
                target = ids[0].rustdesk_id
        elif current is not None:
            newer = [p for p in ids if p.created_at > current.created_at]
            if len(newer) == 1 and newer[0].rustdesk_id not in {d for d in [device.rustdesk_id]}:
                target = newer[0].rustdesk_id
            elif not newer:
                target = device.rustdesk_id
        if target is None:
            return "unknown"
        return self._apply(device, target, rows, now, by_id)

    def _apply(self, device: Device, target: str, rows, now, by_id) -> str:
        peer = by_id.get(target)
        row = rows.get((peer.uuid_b64, target)) if peer else None
        if row is None:
            return "unknown"
        if device.rustdesk_id == target:
            # Written only when it changes or every few hours: ~1,000 devices
            # every 5 minutes would otherwise rewrite every row.
            stale = device.rustdesk_verified_at is None or now - _naive(device.rustdesk_verified_at) > VERIFIED_REFRESH
            if device.rustdesk_id_source not in ("remote_support", "manual", "id_server") or stale:
                device.rustdesk_verified_at = now
                if device.rustdesk_id_source not in ("remote_support", "manual"):
                    device.rustdesk_id_source = "id_server"
            return "verified"
        if device.rustdesk_manual_override:
            row.note = "The device's ID is pinned by an operator"
            return "unknown"
        # Reuse the client-report rules: clones by reporting order do not
        # apply here (hbbs has no last-seen), holders are released when dead.
        holder = (
            self.db.query(Device)
            .filter(Device.rustdesk_id == target, Device.id != device.id)
            .first()
        )
        if holder is not None and not self.presence._releasable(holder, now):
            row.note = f"ID also held by device #{holder.id}"
            return "unknown"
        if holder is not None:
            self.presence._release(holder, target, device)
        old = device.rustdesk_id
        device.rustdesk_id = target
        device.rustdesk_id_source = "id_server"
        device.rustdesk_verified_at = now
        device.rustdesk_synced_at = now
        device.rustdesk_sync_state = "synced"
        device.rustdesk_sync_message = None
        device.rustdesk_conflict_detected = False
        row.device_id, row.bound_by, row.note = device.id, "id_server", None
        self.db.flush()
        row.bound_by = "id_server"
        self.presence._record_change(device, old, row)
        return "corrected"
