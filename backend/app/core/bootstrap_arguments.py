import re


_REMOTE_SUPPORT_DEVICE_IDS_RE = re.compile(r"[1-9][0-9]*(?:,[1-9][0-9]*)*")
_REMOTE_SUPPORT_REPAIR_MODES = {"disabled", "canary", "enabled"}


def canonical_remote_support_device_ids(value: str) -> str:
    raw = value or ""
    if not raw:
        return ""
    if _REMOTE_SUPPORT_DEVICE_IDS_RE.fullmatch(raw) is None:
        raise ValueError(
            "REMOTE_SUPPORT_AUTO_REPAIR_DEVICE_IDS must be a comma-separated "
            "list of positive numeric device IDs without spaces"
        )
    return raw


def build_windows_bootstrap_config_invocation(
    *, remote_support_auto_repair_mode: str, remote_support_auto_repair_device_ids: str
) -> str:
    mode = remote_support_auto_repair_mode or ""
    if mode not in _REMOTE_SUPPORT_REPAIR_MODES:
        raise ValueError(
            "REMOTE_SUPPORT_AUTO_REPAIR_MODE must be one of: disabled, canary, enabled"
        )
    device_ids = canonical_remote_support_device_ids(
        remote_support_auto_repair_device_ids
    )
    invocation = (
        "& $AgentExe bootstrap-config "
        "-api-url $BackendUrl "
        "-enrollment-token $Token "
        "-reenroll 1 "
        f"-remote-support-auto-repair-mode {mode}"
    )
    if device_ids:
        invocation += (
            ' -remote-support-auto-repair-device-ids '
            f'"{device_ids}"'
        )
    return invocation
