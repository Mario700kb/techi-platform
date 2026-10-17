"""A client's locations (sites) and which of its devices are at each.

A device is at a location because an operator put it there ("manual") or
because one of the location's rules recognises it ("rule"): the site's
public IP, its LAN network, or both. The most specific rule wins — public IP
and LAN, then LAN alone (longest prefix first), then public IP alone — so a
site behind another site's internet line (a VPN branch) can still be told
apart by its network. Manual placements are never moved by the rules.

Rules belong to one client: two clients behind one IP (a shared office or
data centre) keep their own locations.
"""
import ipaddress
from collections import Counter, defaultdict
from typing import Iterable, Optional, Sequence

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.time import utcnow
from app.models.client_location import ClientLocation
from app.models.device import Device
from app.models.device import ONLINE_WINDOW
from app.repositories.device_repository import DeviceRepository
from app.schemas.client_location import (
    LocationApplyResult,
    LocationList,
    LocationOut,
    LocationStats,
    LocationSuggestion,
    SuggestionNetwork,
)

MANUAL = "manual"
RULE = "rule"

# Addresses that are not a site's LAN: link-local (no DHCP), carrier-grade
# NAT and Tailscale, Radmin VPN, Hamachi. A device reporting one of these as
# its local IP says nothing about where it is.
VIRTUAL_NETWORKS = [
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("26.0.0.0/8"),
    ipaddress.ip_network("25.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
]

# A public IP needs this many unlocated devices before it is suggested: one
# or two are usually laptops on a home line.
SUGGESTION_MIN_DEVICES = 3


def _ip(value: Optional[str]):
    if not value:
        return None
    try:
        return ipaddress.ip_address(value.strip())
    except ValueError:
        return None


def lan_of(local_ip: Optional[str]) -> Optional[str]:
    """The /24 a device's local IPv4 address sits in, or None for an address
    that says nothing about a site (virtual adapters, IPv6, garbage)."""
    address = _ip(local_ip)
    if address is None or address.version != 4 or not address.is_private:
        return None
    if any(address in network for network in VIRTUAL_NETWORKS):
        return None
    return str(ipaddress.ip_network(f"{address}/24", strict=False))


class RuleMatcher:
    """The rules of one client's locations, ready to place its devices."""

    def __init__(self, locations: Iterable[ClientLocation]):
        self._rules = []
        for location in locations:
            for rule in location.rules:
                network = ipaddress.ip_network(rule.lan_cidr, strict=False) if rule.lan_cidr else None
                public = _ip(rule.public_ip)
                if network is None and public is None:
                    continue
                if network is not None and public is not None:
                    rank = (3, network.prefixlen)
                elif network is not None:
                    rank = (2, network.prefixlen)
                else:
                    rank = (1, 0)
                self._rules.append((rank, location.id, public, network))
        # Most specific first; the older location wins a tie.
        self._rules.sort(key=lambda r: (-r[0][0], -r[0][1], r[1]))

    def match(self, public_ip: Optional[str], local_ip: Optional[str]) -> Optional[int]:
        public = _ip(public_ip)
        local = _ip(local_ip)
        for _rank, location_id, rule_public, network in self._rules:
            if rule_public is not None and rule_public != public:
                continue
            if network is not None and (local is None or local.version != network.version or local not in network):
                continue
            return location_id
        return None


class LocationService:
    def __init__(self, db: Session):
        self.db = db

    def locations(self, client_id: int) -> list[ClientLocation]:
        return (
            self.db.query(ClientLocation)
            .filter(ClientLocation.client_id == client_id)
            .order_by(ClientLocation.country, ClientLocation.city, ClientLocation.name, ClientLocation.id)
            .all()
        )

    def _client_devices(self, client_id: int, scope: Optional[AllowedScope]):
        query = self.db.query(Device).filter(Device.client_id == client_id, Device.is_archived.is_(False))
        return DeviceRepository(self.db)._apply_scope_filter(query, scope)

    # ── reading ──────────────────────────────────────────────────────────
    def listing(self, client_id: int, scope: Optional[AllowedScope]) -> LocationList:
        locations = self.locations(client_id)
        rows = DeviceRepository(self.db).location_stats(client_id, {location.id for location in locations}, scope)

        stats: dict[Optional[int], LocationStats] = {}
        manual: dict[Optional[int], int] = {}
        for location_id, total, online, stale, offline, servers, clientpc, pinned in rows:
            stats[location_id] = LocationStats(
                total=total, online=online, stale=stale, offline=offline, servers=servers, clientpc=clientpc
            )
            manual[location_id] = pinned
        return LocationList(
            locations=[
                LocationOut.model_validate(location).model_copy(
                    update={
                        "stats": stats.get(location.id, LocationStats()),
                        "manual_devices": manual.get(location.id, 0),
                    }
                )
                for location in locations
            ],
            unlocated=stats.get(None, LocationStats()),
        )

    def suggestions(self, client_id: int, scope: Optional[AllowedScope]) -> list[LocationSuggestion]:
        """Public IPs that several of the client's unlocated devices share.

        Placed devices drop out, so a site made from one network of an IP
        leaves the IP's other networks suggested; devices an operator put at
        "no location" by hand are not suggested again."""
        online_cutoff = utcnow() - ONLINE_WINDOW
        known = {location.id for location in self.locations(client_id)}
        devices = (
            self._client_devices(client_id, scope)
            .filter(Device.public_ip.isnot(None), or_(Device.location_source.is_(None), Device.location_source != MANUAL))
            .with_entities(Device.public_ip, Device.local_ip, Device.hostname, Device.display_name,
                           Device.last_seen, Device.location_id)
            .all()
        )
        by_ip: dict[str, list] = defaultdict(list)
        for row in devices:
            if row.location_id in known:
                continue
            address = _ip(row.public_ip)
            if address is None or not address.is_global:
                continue
            by_ip[str(address)].append(row)

        suggestions = []
        for public_ip, rows in by_ip.items():
            if len(rows) < SUGGESTION_MIN_DEVICES:
                continue
            lans = Counter(lan for lan in (lan_of(row.local_ip) for row in rows) if lan)
            # A network with one device is noise (a laptop's hotspot, a VPN).
            networks = [SuggestionNetwork(lan_cidr=lan, devices=n) for lan, n in lans.most_common() if n >= 2]
            names = sorted({(row.display_name or row.hostname or "").strip() for row in rows} - {""})
            suggestions.append(LocationSuggestion(
                public_ip=public_ip,
                devices=len(rows),
                online=sum(1 for row in rows if row.last_seen and row.last_seen >= online_cutoff.replace(tzinfo=None)),
                networks=networks,
                other_network_devices=len(rows) - sum(n.devices for n in networks),
                sample_hostnames=names[:5],
            ))
        suggestions.sort(key=lambda s: (-s.devices, s.public_ip))
        return suggestions

    # ── placing devices ──────────────────────────────────────────────────
    def apply_rules(self, client_id: int, *, invalidate: bool = True) -> LocationApplyResult:
        """Place every device of the client that no operator placed by hand."""
        locations = self.locations(client_id)
        matcher = RuleMatcher(locations)
        devices = (
            self.db.query(Device)
            .filter(Device.client_id == client_id, or_(Device.location_source.is_(None), Device.location_source != MANUAL))
            .all()
        )
        assigned = cleared = 0
        for device in devices:
            location_id = matcher.match(device.public_ip, device.local_ip)
            if location_id is not None:
                if device.location_id != location_id or device.location_source != RULE:
                    device.location_id = location_id
                    device.location_source = RULE
                    assigned += 1
            elif device.location_id is not None or device.location_source is not None:
                device.location_id = None
                device.location_source = None
                cleared += 1
        self.db.commit()
        if invalidate and (assigned or cleared):
            _invalidate_tree()
        return LocationApplyResult(assigned=assigned, cleared=cleared)

    def assign(self, client_id: int, scope: Optional[AllowedScope], device_ids: Sequence[int],
               location_id: Optional[int], mode: str) -> list[Device]:
        devices = self._client_devices(client_id, scope).filter(Device.id.in_(list(device_ids))).all()
        if mode == "auto":
            matcher = RuleMatcher(self.locations(client_id))
            for device in devices:
                match = matcher.match(device.public_ip, device.local_ip)
                device.location_id = match
                device.location_source = RULE if match is not None else None
        else:
            for device in devices:
                device.location_id = location_id
                device.location_source = MANUAL
        self.db.commit()
        _invalidate_tree()
        return devices


def sweep_location_rules(db: Session) -> LocationApplyResult:
    """Every client with locations, placed again by its rules: new devices,
    and devices whose public IP or network changed, reach their site without
    anyone pressing Re-apply. Writes nothing when nothing moved."""
    from app.services.audit_service import AuditAction, system_audit_log

    service = LocationService(db)
    client_ids = [row[0] for row in db.query(ClientLocation.client_id).distinct().all()]
    assigned = cleared = 0
    for client_id in client_ids:
        result = service.apply_rules(client_id, invalidate=False)
        if result.assigned or result.cleared:
            assigned += result.assigned
            cleared += result.cleared
            system_audit_log(db, action=AuditAction.CLIENT_LOCATIONS_APPLIED, entity_type="client",
                             entity_id=client_id, details={"client_id": client_id, "trigger": "schedule",
                                                           "assigned": result.assigned, "cleared": result.cleared})
    if assigned or cleared:
        _invalidate_tree()
    return LocationApplyResult(assigned=assigned, cleared=cleared)


def _invalidate_tree() -> None:
    # The Explorer and the client profile read the cached fleet overview.
    from app.services.device_overview_service import invalidate_overview_cache

    invalidate_overview_cache()
