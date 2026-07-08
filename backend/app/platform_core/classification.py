"""Unified Classification Engine — the ONE source of truth for a device's
Category and Platform.

Design (see docs/reference/UNIFIED-CLASSIFICATION-ENGINE-SPEC.md):
  * ONE ordered rule table (`_CATEGORY_RULES`) + ONE set of shared constants.
  * TWO renderers generated from that single source:
      - SQL:       `category_case()`, `platform_case()`  -> SQLAlchemy expressions
      - in-memory: `classify_category()`, `classify_platform()` -> pure Python
  * A parity contract test proves the two renderers return identical results for
    every branch, so they can never drift (SQL result == in-memory result).

Windows is the reference implementation. The Category axis answers *what a device
is*; it never derives *who owns it* (that is the Client axis in
DeviceAssignmentService, manual override included).

Consumers (tree badges, overview counters, catalog/search filters, smart folders,
Drawer/resolution, enrollment placement, Command Center, Packages, future
platforms) MUST call this module and never re-implement a CASE or a heuristic.

NOTE: every SQL renderer that references a group name requires the query to
outer-join DeviceGroup (`.outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)`).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from sqlalchemy import and_, case, or_

from app.models.device import Device, DeviceType
from app.models.device_group import DeviceGroup

# --------------------------------------------------------------------------- #
# Category + platform vocabulary
# --------------------------------------------------------------------------- #
CATEGORY_SERVERS = "servers"
CATEGORY_CLIENTPC = "clientpc"
CATEGORY_NETWORK = "network"
CATEGORY_STORAGE = "storage"
CATEGORY_HYPERVISORS = "hypervisors"
CATEGORY_PRINTERS = "printers"
CATEGORY_IOT = "iot"
CATEGORY_OTHER = "other"
CATEGORY_UNASSIGNED = "unassigned"

PLATFORM_WINDOWS = "windows"

# --------------------------------------------------------------------------- #
# Shared constants — defined ONCE, consumed by both renderers.
# --------------------------------------------------------------------------- #
# Platform detection: ordered (substring, platform_class). NULL / no match =>
# windows (audit §8: absence ⇒ Windows).
_PLATFORM_TABLE: tuple[tuple[str, str], ...] = (
    ("linux", "linux"),
    ("darwin", "macos"),
    ("macos", "macos"),
    ("mikrotik", "mikrotik"),
    ("routeros", "mikrotik"),
    ("synology", "synology"),
    ("qnap", "qnap"),
    ("vmware", "vmware"),
    ("esxi", "vmware"),
    ("proxmox", "proxmox"),
    ("hyperv", "hyperv"),
    ("unifi", "unifi"),
    ("cisco", "cisco"),
)

# Agent platforms live in the Servers/Client PC world; everything else is a
# non-agent platform whose Category is fixed by its platform class.
_AGENT_PLATFORM_CLASSES = frozenset({"windows", "linux", "macos"})
_NON_AGENT_CATEGORY: dict[str, str] = {
    "mikrotik": CATEGORY_NETWORK,
    "unifi": CATEGORY_NETWORK,
    "cisco": CATEGORY_NETWORK,
    "synology": CATEGORY_STORAGE,
    "qnap": CATEGORY_STORAGE,
    "vmware": CATEGORY_HYPERVISORS,
    "proxmox": CATEGORY_HYPERVISORS,
    "hyperv": CATEGORY_HYPERVISORS,
}

# Standard group-name vocabulary (case-insensitive equality, mirrors the historic
# smart-folder / resolution sets exactly).
_SERVER_GROUP_NAMES = frozenset({"servers", "server"})
_CLIENT_GROUP_NAMES = frozenset({"client pc", "client pcs", "workstation", "workstations"})

# Server OS signal (matches the pre-expansion overview classifier verbatim).
_SERVER_OS_MARKER = "windows server"
_SERVER_PRODUCT_TYPES = frozenset({2, 3})


# --------------------------------------------------------------------------- #
# Normalized in-memory row — every Python consumer funnels through this.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ClassificationInput:
    client_id: Optional[int]
    group_id: Optional[int]
    group_name: Optional[str]
    platform: Optional[str]
    device_type: Optional[object]  # DeviceType | str | None
    windows_product_type: Optional[int]
    os_name: Optional[str]
    os_version: Optional[str]
    os_caption: Optional[str]

    @classmethod
    def from_device(cls, device) -> "ClassificationInput":
        group = getattr(device, "group", None)
        return cls(
            client_id=getattr(device, "client_id", None),
            group_id=getattr(device, "group_id", None),
            group_name=getattr(group, "name", None) if group is not None else getattr(device, "group_name", None),
            platform=getattr(device, "platform", None),
            device_type=getattr(device, "device_type", None),
            windows_product_type=getattr(device, "windows_product_type", None),
            os_name=getattr(device, "os_name", None),
            os_version=getattr(device, "os_version", None),
            os_caption=getattr(device, "os_caption", None),
        )

    @property
    def _os_text(self) -> str:
        return " ".join(
            (v or "").strip().lower()
            for v in (self.os_name, self.os_version, self.os_caption)
            if (v or "").strip()
        )

    @property
    def _group_norm(self) -> str:
        return (self.group_name or "").strip().lower()


# --------------------------------------------------------------------------- #
# Platform axis — derived exactly once.
# --------------------------------------------------------------------------- #
def classify_platform(platform: Optional[str]) -> str:
    p = (platform or "").strip().lower()
    for substring, cls in _PLATFORM_TABLE:
        if substring in p:
            return cls
    return PLATFORM_WINDOWS


def platform_case():
    return case(
        *[(Device.platform.ilike(f"%{substring}%"), cls) for substring, cls in _PLATFORM_TABLE],
        else_=PLATFORM_WINDOWS,
    ).label("platform_class")


def _nonagent_substrings(category: str) -> list[str]:
    classes = {cls for cls, cat in _NON_AGENT_CATEGORY.items() if cat == category}
    return [sub for sub, cls in _PLATFORM_TABLE if cls in classes]


# --------------------------------------------------------------------------- #
# Category axis — ONE ordered rule table, each rule carrying BOTH renderers.
# `py` : Callable[[ClassificationInput], bool]  ·  `sql` : SQLAlchemy expression
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _Rule:
    py: Callable[[ClassificationInput], bool]
    sql: object
    result: str


def _is_server_os(r: ClassificationInput) -> bool:
    dt = r.device_type
    dt_val = getattr(dt, "value", dt)
    return (
        dt == DeviceType.SERVER
        or dt_val == "server"
        or (r.windows_product_type in _SERVER_PRODUCT_TYPES)
        or (_SERVER_OS_MARKER in r._os_text)
    )


_SERVER_OS_SQL = or_(
    Device.device_type == DeviceType.SERVER,
    Device.windows_product_type.in_(list(_SERVER_PRODUCT_TYPES)),
    Device.os_name.ilike(f"%{_SERVER_OS_MARKER}%"),
    Device.os_version.ilike(f"%{_SERVER_OS_MARKER}%"),
    Device.os_caption.ilike(f"%{_SERVER_OS_MARKER}%"),
)


def _nonagent_py(category: str) -> Callable[[ClassificationInput], bool]:
    return lambda r: _NON_AGENT_CATEGORY.get(classify_platform(r.platform)) == category


def _nonagent_sql(category: str):
    subs = _nonagent_substrings(category)
    return or_(*[Device.platform.ilike(f"%{sub}%") for sub in subs])


# The single ordered rule list. Order == owner precedence:
#   0 unassigned guard · 1 Existing DB Group (standard) · 2 Windows/structural
#   (non-agent platform class) · 3 OS heuristic · 4 Other · default clientpc.
_CATEGORY_RULES: tuple[_Rule, ...] = (
    _Rule(
        py=lambda r: r.client_id is None and r.group_id is None,
        sql=and_(Device.client_id.is_(None), Device.group_id.is_(None)),
        result=CATEGORY_UNASSIGNED,
    ),
    _Rule(
        py=lambda r: r._group_norm in _SERVER_GROUP_NAMES,
        sql=or_(*[DeviceGroup.name.ilike(name) for name in sorted(_SERVER_GROUP_NAMES)]),
        result=CATEGORY_SERVERS,
    ),
    _Rule(
        py=lambda r: r._group_norm in _CLIENT_GROUP_NAMES,
        sql=or_(*[DeviceGroup.name.ilike(name) for name in sorted(_CLIENT_GROUP_NAMES)]),
        result=CATEGORY_CLIENTPC,
    ),
    _Rule(py=_nonagent_py(CATEGORY_NETWORK), sql=_nonagent_sql(CATEGORY_NETWORK), result=CATEGORY_NETWORK),
    _Rule(py=_nonagent_py(CATEGORY_STORAGE), sql=_nonagent_sql(CATEGORY_STORAGE), result=CATEGORY_STORAGE),
    _Rule(py=_nonagent_py(CATEGORY_HYPERVISORS), sql=_nonagent_sql(CATEGORY_HYPERVISORS), result=CATEGORY_HYPERVISORS),
    _Rule(py=_is_server_os, sql=_SERVER_OS_SQL, result=CATEGORY_SERVERS),
    _Rule(
        py=lambda r: r.group_id is not None,
        sql=Device.group_id.isnot(None),
        result=CATEGORY_OTHER,
    ),
)
_CATEGORY_DEFAULT = CATEGORY_CLIENTPC


def classify_category(source) -> str:
    """In-memory renderer. Accepts a Device (or any object with the fields) or a
    ready ClassificationInput."""
    r = source if isinstance(source, ClassificationInput) else ClassificationInput.from_device(source)
    for rule in _CATEGORY_RULES:
        if rule.py(r):
            return rule.result
    return _CATEGORY_DEFAULT


def category_case():
    """SQL renderer. Requires DeviceGroup outer-joined to the query."""
    return case(
        *[(rule.sql, rule.result) for rule in _CATEGORY_RULES],
        else_=_CATEGORY_DEFAULT,
    ).label("category")
