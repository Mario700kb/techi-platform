"""Version Service — the single place that compares a device's reported
version against its platform's "latest" version and renders a 3-state status
(current / outdated / ahead). One function, every platform:

- Agent platforms (Windows today) compare against the active AgentPackage —
  delegates to the exact logic device_overview_service.py already uses for
  the fleet dashboard (untouched, not re-implemented here).
- Connector platforms (MikroTik, future Synology/QNAP/VMware/...) compare
  against `PLATFORM_REGISTRY[platform].latest_connector_version` — bump that
  ONE field when a platform's deployment template changes and every consumer
  (script generation, Drawer badge, Device List badge) updates together.

No platform-specific badge logic anywhere else in the codebase should exist;
callers ask this module "what's the status" and render accordingly.
"""
from typing import Literal, Optional

from app.platform_core.registry import resolve_platform
from app.platform_core.versioning import compare_numeric
from app.services.agent_package_service import AgentPackageService

VersionStatus = Literal["current", "outdated", "ahead", "unknown"]


def get_active_version(platform_id: Optional[str]) -> Optional[str]:
    """The version a device on this platform is expected to report."""
    descriptor = resolve_platform(platform_id)
    if descriptor is not None and descriptor.latest_connector_version:
        return descriptor.latest_connector_version
    if descriptor is None or descriptor.id == "windows":
        service = AgentPackageService()
        pkg = service.latest_active("windows-amd64", file_type="agent_binary") or service.latest_active("windows-amd64")
        return pkg.version if pkg else None
    return None


def compare_versions(reported: Optional[str], latest: Optional[str]) -> VersionStatus:
    """reported == latest -> "current"; reported older -> "outdated";
    reported newer -> "ahead". Numeric comparison treats missing trailing
    segments as zero, so ``1.4.6`` == ``1.4.6.0`` -> "current" and
    ``2.1.20`` > ``2.1.19.9`` -> "ahead". Both sides missing/empty -> "unknown";
    a single unparseable, non-equal side folds to "outdated" (unchanged
    fail-closed behaviour — a device reporting a version we can't parse against a
    known latest is treated as needing attention, not silently current)."""
    reported = (reported or "").strip()
    latest = (latest or "").strip()
    if not reported or not latest:
        return "unknown"
    if reported == latest:
        return "current"
    cmp = compare_numeric(reported, latest)
    if cmp is None:
        return "outdated"
    if cmp == 0:
        return "current"
    return "ahead" if cmp > 0 else "outdated"
