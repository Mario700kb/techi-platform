"""Version Service — the single place that compares a device's reported
version against its platform's "latest" version and renders a 3-state status
(current / outdated / ahead). One function, every platform:

- Agent platforms (Windows, Linux) compare against the active AgentPackage for
  the device's own architecture — delegates to the exact logic
  device_overview_service.py already uses for the fleet dashboard (untouched,
  not re-implemented here). Linux was declared here from the start but never
  resolved: the lookup only ever asked for `windows-amd64`, so every Linux
  device fell through to `None` and its badge showed "unknown" no matter how
  current the agent was (fixed 2026-08-05).
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


# An agent platform's "latest" is the active package for the device's OWN
# architecture. Comparing an arm64 endpoint against the amd64 build would mark
# it outdated the moment the two lines diverge, which is a false alarm, not a
# rollout signal. Keys are what `uname -m` reports, lowercased.
_LINUX_ARCH_PACKAGES = {
    "x86_64": "linux-amd64",
    "amd64": "linux-amd64",
    "aarch64": "linux-arm64",
    "arm64": "linux-arm64",
    "armv7l": "linux-armhf",
    "armv6l": "linux-armhf",
    "armhf": "linux-armhf",
}


def linux_architectures() -> tuple:
    """Every `uname -m` value that maps to a Linux agent package.

    Exposed so the fleet overview can publish a version per architecture
    without the arch->package table being duplicated in the frontend.
    """
    return tuple(_LINUX_ARCH_PACKAGES)


def package_platform(platform_id: Optional[str], architecture: Optional[str]) -> Optional[str]:
    """Which AgentPackage platform key holds this device's expected version."""
    if platform_id is None or platform_id == "windows":
        return "windows-amd64"
    if platform_id == "linux":
        # Unknown/absent architecture returns None, so the badge stays
        # "unknown" rather than guessing a build the device may not run.
        return _LINUX_ARCH_PACKAGES.get((architecture or "").strip().lower())
    return None


def get_active_version(
    platform_id: Optional[str], architecture: Optional[str] = None
) -> Optional[str]:
    """The version a device on this platform is expected to report."""
    descriptor = resolve_platform(platform_id)
    if descriptor is not None and descriptor.latest_connector_version:
        return descriptor.latest_connector_version

    platform_key = package_platform(
        descriptor.id if descriptor is not None else None, architecture
    )
    if platform_key is None:
        return None
    service = AgentPackageService()
    pkg = (
        service.latest_active(platform_key, file_type="agent_binary")
        or service.latest_active(platform_key)
    )
    return pkg.version if pkg else None


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
