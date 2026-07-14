from dataclasses import dataclass
from typing import Optional


TRUSTED_USABLE_STATES = {"healthy", "installed_running"}
KNOWN_STATES = {
    "healthy",
    "installed_running",
    "installed_stopped",
    "missing",
    "damaged",
    "unknown",
    "legacy_status_unavailable",
    "repair_pending",
    "repair_failed",
}


@dataclass(frozen=True)
class RemoteSupportState:
    state: str
    reason: str

    @property
    def connect_allowed(self) -> bool:
        return self.state in TRUSTED_USABLE_STATES


def classify_authenticated_remote_support(
    *, install_status: Optional[str], runtime_status: Optional[str]
) -> RemoteSupportState:
    install = (install_status or "unknown").strip().lower()
    runtime = (runtime_status or "unknown").strip().lower()

    damaged_runtime = {
        "damaged",
        "stale_service",
        "service_missing",
        "executable_missing",
        "partial_install",
        "locked_runtime",
        "pending_reboot",
        "version_mismatch",
        "config_conflict",
    }
    if install in {"damaged", "partial", "partial_install"} or runtime in damaged_runtime:
        return RemoteSupportState("damaged", runtime if runtime in damaged_runtime else install)
    if install in {"missing", "not_installed", "not installed", "absent"}:
        return RemoteSupportState("missing", "authenticated_install_absent")
    if install in {"installed", "healthy"} and runtime == "running":
        return RemoteSupportState("installed_running", "authenticated_runtime_running")
    if install in {"installed", "healthy"} and runtime in {"stopped", "not_running", "offline"}:
        return RemoteSupportState("installed_stopped", "authenticated_runtime_stopped")
    return RemoteSupportState("unknown", "authenticated_status_incomplete")
