"""Contract: the Unified Classification Engine's SQL renderer and in-memory
renderer MUST return identical results, and Windows outcomes are locked to a
golden snapshot. This is the mechanical guarantee behind
'SQL result == in-memory result' and 'tree badges == catalog filters'.
"""
import itertools

from sqlalchemy import create_engine
from sqlalchemy.orm import joinedload, sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.platform_core import classification as clf


def _session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


# Every branch of the engine is represented in this matrix.
_PLATFORMS = [None, "", "windows", "Windows", "linux", "darwin", "mikrotik",
              "routeros", "synology", "qnap", "vmware", "esxi", "proxmox",
              "hyperv", "unifi", "cisco", "somethingelse"]
_GROUPS = [None, "Servers", "Server", "Client PC", "Workstations",
           "Domain Controllers", "Kiosks"]
_PRODUCT_TYPES = [None, 1, 2, 3]
_CAPTIONS = [None, "Microsoft Windows 10 Pro", "Microsoft Windows Server 2019 Standard"]
_CLIENTS = [True, False]


def _build_matrix(s):
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.flush()
    group_ids = {}
    for name in _GROUPS:
        if name is None:
            continue
        g = DeviceGroup(client_id=client.id, name=name)
        s.add(g)
        s.flush()
        group_ids[name] = g.id

    combos = itertools.product(_PLATFORMS, _GROUPS, _PRODUCT_TYPES, _CAPTIONS, _CLIENTS)
    for platform, group_name, wpt, caption, has_client in combos:
        s.add(Device(
            hostname="h",
            platform=platform,
            group_id=group_ids.get(group_name),
            client_id=client.id if has_client else None,
            windows_product_type=wpt,
            os_caption=caption,
            device_type=DeviceType.UNASSIGNED,
            status=DeviceStatus.OFFLINE,
        ))
    s.commit()


def test_sql_and_in_memory_renderers_agree_on_every_row():
    s = _session()
    _build_matrix(s)

    # SQL renderer: category + platform per row (DeviceGroup outer-joined).
    sql_rows = dict(
        (row.id, (row.category, row.platform_class))
        for row in s.query(
            Device.id,
            clf.category_case(),
            clf.platform_case(),
        ).outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id).all()
    )

    # In-memory renderer over the same rows (group relationship loaded).
    devices = s.query(Device).options(joinedload(Device.group)).all()
    assert len(devices) == len(sql_rows) > 0
    mismatches = []
    for d in devices:
        py_cat = clf.classify_category(d)
        py_plat = clf.classify_platform(d.platform)
        sql_cat, sql_plat = sql_rows[d.id]
        if (py_cat, py_plat) != (sql_cat, sql_plat):
            mismatches.append(
                f"id={d.id} platform={d.platform!r} group={getattr(d.group,'name',None)!r} "
                f"wpt={d.windows_product_type} caption={d.os_caption!r} client={d.client_id} :: "
                f"py=({py_cat},{py_plat}) sql=({sql_cat},{sql_plat})"
            )
    assert not mismatches, "SQL != in-memory:\n" + "\n".join(mismatches[:20])
    s.close()


def test_golden_windows_outcomes_are_locked():
    """Representative real Windows cases — a change here means a Windows behaviour
    change and must be deliberate."""
    def ci(**kw):
        base = dict(client_id=1, group_id=None, group_name=None, platform="windows",
                    device_type=DeviceType.UNASSIGNED, windows_product_type=None,
                    os_name=None, os_version=None, os_caption=None)
        base.update(kw)
        return clf.ClassificationInput(**base)

    # Standard groups win (Existing DB Group).
    assert clf.classify_category(ci(group_id=5, group_name="Servers")) == "servers"
    assert clf.classify_category(ci(group_id=6, group_name="Client PC")) == "clientpc"
    # Ungrouped product-type server (the Agroblend0/Eugreen case, matches e08544d).
    assert clf.classify_category(ci(windows_product_type=3)) == "servers"
    assert clf.classify_category(ci(windows_product_type=2)) == "servers"
    # Ungrouped workstation.
    assert clf.classify_category(ci(windows_product_type=1)) == "clientpc"
    # Custom group: server-by-OS still servers; non-server -> Other (D1).
    assert clf.classify_category(ci(group_id=7, group_name="Domain Controllers", windows_product_type=2)) == "servers"
    assert clf.classify_category(ci(group_id=8, group_name="Kiosks", windows_product_type=1)) == "other"
    # Caption fallback.
    assert clf.classify_category(ci(os_caption="Microsoft Windows Server 2022")) == "servers"
    # Truly unassigned.
    assert clf.classify_category(ci(client_id=None, group_id=None)) == "unassigned"
    # NULL platform => windows.
    assert clf.classify_platform(None) == "windows"
    assert clf.classify_platform("") == "windows"


def test_golden_nonagent_platforms():
    def ci(platform, **kw):
        base = dict(client_id=1, group_id=None, group_name=None, platform=platform,
                    device_type=DeviceType.UNASSIGNED, windows_product_type=None,
                    os_name=None, os_version=None, os_caption=None)
        base.update(kw)
        return clf.ClassificationInput(**base)

    assert clf.classify_category(ci("mikrotik")) == "network"
    assert clf.classify_category(ci("routeros")) == "network"
    assert clf.classify_category(ci("unifi")) == "network"
    assert clf.classify_category(ci("synology")) == "storage"
    assert clf.classify_category(ci("qnap")) == "storage"
    assert clf.classify_category(ci("vmware")) == "hypervisors"
    assert clf.classify_category(ci("proxmox")) == "hypervisors"
    assert clf.classify_category(ci("hyperv")) == "hypervisors"
