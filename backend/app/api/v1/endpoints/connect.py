"""Connect Framework API (Platform Expansion Phase 7).

`GET /devices/{id}/connect-methods` returns the connection methods available
for a device, generated from the Connect metadata + the device's reported
capabilities. The frontend Connect dropdown is built entirely from this — no
hardcoded per-platform dropdowns.

`GET /devices/{id}/connect-methods/{method_id}/launch` returns the launch URL
for a method (desktop scheme or browser URL built from the device's IP) —
generic for every platform via `ConnectMethod.scheme`/`web_path`, no
per-platform launcher code. Permission and audit reuse the same
`remote_support_connect` permission and `remote_connect` audit action as the
existing Windows Remote Support connect flow.

Gated by FEATURE_PLATFORM_CORE (404 when off) so today's production, where the
existing Windows Connect button is untouched, is unchanged.
"""

import json
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_team_permission
from app.db.session import get_db
from app.models.device import Device
from app.models.operator import Operator
from app.platform_core import classification as clf
from app.platform_core.actions import actions_for, effective_capabilities
from app.platform_core.capabilities import capability_tabs
from app.platform_core.connect import ConnectMethod, methods_for
from app.platform_core.flags import feature_enabled
from app.platform_core.registry import resolve_platform
from app.platform_core.rollout import is_device_in_rollout
from app.repositories.device_repository import DeviceRepository
from app.services import version_service
from app.services.audit_service import AuditAction, audit_log
from app.services.connect_preference_service import ConnectPreferenceService
from app.api.v1.endpoints.vault import _vault_gate
from app.models.operator import OperatorRole
from app.services.permission_service import REMOTE_SUPPORT_CONNECT, VAULT_REVEAL
from app.services.vault_service import METHOD_CREDENTIAL_TYPES, VaultService

router = APIRouter()

# remote_support/web_terminal have their own dedicated, already-audited flows
# (Remote Support tab / Terminal tab) — always "ready" from Connect's point of
# view; readiness there is governed by their own tab/capability, not a Vault
# credential.
_DEDICATED_METHOD_IDS = frozenset({"remote_support", "web_terminal"})

# The Vault's own reveal gate (ADMIN role OR the vault_reveal team permission),
# imported rather than re-implemented: duplicating a security check is how two
# copies quietly drift apart. Used by the Connect credential endpoint below.
_require_vault_reveal = _vault_gate(OperatorRole.ADMIN.value, VAULT_REVEAL)


def credential_port(db: Session, device, method_id: str) -> Optional[int]:
    """Port carried by the Vault credential resolved for this method, if any.

    Precedence, decided deliberately because two places can now express a port:
    the device's own `connect_port` wins, and this is only the fallback. The
    device field is the operator's explicit statement about THIS device, while
    the credential's port travels with a credential that may be shared across a
    whole client or the entire fleet — so the narrower, more specific one wins.

    Reads `metadata_json` only. That column is non-secret by construction (see
    VaultCredential), so this needs no reveal, no decryption and no audit event.
    """
    try:
        _tier, candidates = VaultService(db).resolve_credentials_for_method(device, method_id)
    except Exception:  # never let credential lookup break a launch
        return None
    for candidate in candidates:
        if not candidate.metadata_json:
            continue
        try:
            raw = json.loads(candidate.metadata_json).get("port")
        except (ValueError, TypeError):
            continue
        try:
            parsed = int(str(raw).strip())
        except (TypeError, ValueError):
            continue
        if 1 <= parsed <= 65535:
            return parsed
    return None


def resolve_connect_host(device, platform_id: str) -> Optional[str]:
    """Which address the Connect launcher should dial.

    1. `device.connect_host` when the operator set one. It is the only way to
       express a target the agent cannot report — most often a router reached
       over the office VPN on its LAN address.
    2. Network gear prefers `public_ip`. A router IS the NAT device, so the
       address the platform observed the heartbeat arriving from is the router
       itself and is directly reachable. Preferring `local_ip` produced
       `winbox://192.168.88.1` — a LAN address no operator outside that LAN can
       reach, which is why all three MikroTik Connect methods failed.
    3. Everything else keeps `local_ip` first, unchanged. For a PC or a NAS the
       observed `public_ip` is the customer's edge, not the device, so it is
       the wrong target — this rule deliberately does NOT generalise beyond
       network gear.

    "Network gear" is decided by the Unified Classification Engine rather than a
    platform list here, so this can never disagree with the tree or the counters.
    """
    if (device.connect_host or "").strip():
        return device.connect_host.strip()
    if clf.classify_category(device) == clf.CATEGORY_NETWORK:
        return device.public_ip or device.local_ip
    return device.local_ip or device.public_ip


class ConnectMethodOut(BaseModel):
    id: str
    label: str
    surface: str            # desktop | browser
    capability: Optional[str] = None
    priority: int
    scheme: Optional[str] = None
    # Operator client OS this method's desktop app requires (e.g. "windows"
    # for Winbox), or None if it works on any OS. A method that doesn't match
    # the operator's OS is shown DISABLED with a reason, never hidden
    # (approved V3 Connect mockup).
    requires_client_os: Optional[str] = None
    # Section E: separates "does this method exist for the platform" (it's in
    # this list at all) from "can the operator actually use it right now".
    status: str = "ready"  # ready | credential_required | unavailable
    status_reason: Optional[str] = None
    # Which Vault scope tier resolved the credential that makes this method
    # Ready (device|group|client|global) — None when no credential is
    # involved (native methods) or when status != ready.
    credential_source: Optional[str] = None
    # Approved V3 Connect mockup: short transport/source label + static menu
    # section kind (available|web|desktop_app) + whether the method runs
    # inside TECHI on the Terminal stack.
    transport: str = ""
    category: str = "available"
    embedded: bool = False


class ConnectMethodsResponse(BaseModel):
    platform: str
    methods: List[ConnectMethodOut]
    # Section G: the operator's effective default for this device, after
    # applying the 4-tier hierarchy (device override > platform default >
    # registry priority > first Ready method).
    preferred_method_id: Optional[str] = None
    # What the operator actually configured (device or platform level), even
    # if it isn't the effective default right now because it's not Ready —
    # lets the frontend say "X isn't available, using Y instead".
    configured_preference_id: Optional[str] = None


def _method_status(
    db: Session, device: Device, method: ConnectMethod, client_os: Optional[str] = None,
) -> Tuple[str, Optional[str], Optional[str]]:
    """Returns (status, reason, credential_source), in precedence order:

    1. "unavailable" — the method's desktop app doesn't exist on the
       OPERATOR's OS (`client_os` query param vs `requires_client_os`), or an
       embedded method's Terminal stack isn't enabled for this device
       (FEATURE_TERMINAL flag + rollout scope — the exact same gates
       POST /terminal/sessions enforces, reflected honestly instead of a
       method that fails on click).
    2. "credential_required" — Section D/F: a method that needs a Vault
       credential (ssh/winbox/webfig) until resolve_credentials_for_method
       finds at least one ACTIVE, type-matched candidate.
    3. "ready".
    """
    if method.requires_client_os and client_os and method.requires_client_os != client_os:
        return "unavailable", f"{method.requires_client_os.capitalize()} only — unavailable on this operating system", None
    if method.embedded and (
        not feature_enabled("FEATURE_TERMINAL") or not is_device_in_rollout("FEATURE_TERMINAL", device)
    ):
        return "unavailable", "Embedded terminal is not enabled for this device yet", None
    if method.id == "ssh" and not feature_enabled("FEATURE_SSH"):
        # Shown, not hidden — the same principle the Winbox/client-OS case
        # follows. The reason is the actual one: the backend dials the device
        # itself, so a NAT'd endpoint can never be reached (RISK-SSH-001).
        return "unavailable", "Embedded SSH is off — it requires a direct route from the platform to the device", None
    if method.id in _DEDICATED_METHOD_IDS or method.id not in METHOD_CREDENTIAL_TYPES:
        return "ready", None, None
    tier, candidates = VaultService(db).resolve_credentials_for_method(device, method.id)
    if candidates:
        return "ready", None, tier
    return "credential_required", "No compatible credential configured", None


def _resolve_preferred_method(
    methods: List[ConnectMethod],
    statuses: List[Tuple[str, Optional[str], Optional[str]]],
    configured_preference: Optional[str],
) -> Optional[str]:
    """Tiers 3-4 of the Section G hierarchy, applied on top of whatever tiers
    1-2 (device override / platform default) resolved into
    `configured_preference`. An "unavailable" method (wrong operator OS /
    Terminal stack not enabled) can never be the effective default."""
    ready_ids = [m.id for m, (status, _, _) in zip(methods, statuses) if status == "ready"]
    if configured_preference and configured_preference in ready_ids:
        return configured_preference
    # Configured preference (if any) isn't Ready right now, or none was set —
    # fall back to the registry's own priority order (methods_for() already
    # sorts by ConnectMethod.priority), else the first genuinely Ready method,
    # else the first method that at least could work once a credential exists.
    if methods and methods[0].id in ready_ids:
        return methods[0].id
    if ready_ids:
        return ready_ids[0]
    usable = [m.id for m, (status, _, _) in zip(methods, statuses) if status != "unavailable"]
    return usable[0] if usable else None


def _method_out(m: ConnectMethod, status: str, reason: Optional[str], credential_source: Optional[str]) -> ConnectMethodOut:
    return ConnectMethodOut(
        id=m.id, label=m.label, surface=m.surface,
        capability=m.capability, priority=m.priority, scheme=m.scheme,
        requires_client_os=m.requires_client_os,
        status=status, status_reason=reason, credential_source=credential_source,
        transport=m.transport, category=m.category, embedded=m.embedded,
    )


@router.get("/devices/{device_id}/connect-methods", response_model=ConnectMethodsResponse)
def device_connect_methods(
    device_id: int,
    client_os: Optional[str] = None,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
):
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    methods = methods_for(platform_id, device.capabilities)
    statuses = [_method_status(db, device, m, client_os) for m in methods]

    configured_preference = ConnectPreferenceService(db).get_preferred_method_id(
        operator.id, platform_id, device_id,
    )
    preferred_method_id = _resolve_preferred_method(list(methods), statuses, configured_preference)

    return ConnectMethodsResponse(
        platform=platform_id,
        methods=[
            _method_out(m, status, reason, credential_source)
            for m, (status, reason, credential_source) in zip(methods, statuses)
        ],
        preferred_method_id=preferred_method_id,
        configured_preference_id=configured_preference,
    )


class ConnectStatusOut(BaseModel):
    """One Device Catalog row's Connect button state — Ready / Credential
    required / Unavailable — with the reason for the tooltip and the effective
    default method for the main-click launch. Aggregated across the device's
    methods: any Ready method ⇒ ready; else any credential_required ⇒
    credential_required; else unavailable. Never contains a secret."""
    device_id: int
    platform: str
    state: str  # ready | credential_required | unavailable
    reason: Optional[str] = None
    preferred_method_id: Optional[str] = None
    preferred_method_label: Optional[str] = None
    method_count: int = 0


_CONNECT_STATUS_MAX_IDS = 200


@router.get("/connect-status", response_model=List[ConnectStatusOut])
def devices_connect_status(
    device_ids: str,
    client_os: Optional[str] = None,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
):
    """Batch Connect-button state for the Device Catalog's visible rows (the
    per-row alternative would be an N+1 of /connect-methods calls). Windows
    rows keep their separate RustDesk check and never call this."""
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    ids: List[int] = []
    for part in device_ids.split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    if len(ids) > _CONNECT_STATUS_MAX_IDS:
        raise HTTPException(status_code=400, detail=f"At most {_CONNECT_STATUS_MAX_IDS} device_ids per request")

    repo = DeviceRepository(db)
    pref_service = ConnectPreferenceService(db)
    out: List[ConnectStatusOut] = []
    for device_id in ids:
        device = repo.get(device_id)
        if device is None:
            continue
        descriptor = resolve_platform(device.platform)
        platform_id = descriptor.id if descriptor is not None else "windows"
        methods = list(methods_for(platform_id, device.capabilities))
        statuses = [_method_status(db, device, m, client_os) for m in methods]
        configured = pref_service.get_preferred_method_id(operator.id, platform_id, device_id)
        preferred_id = _resolve_preferred_method(methods, statuses, configured)
        by_id = {m.id: m for m in methods}
        status_values = [s for s, _, _ in statuses]
        if "ready" in status_values:
            state, reason = "ready", None
        elif "credential_required" in status_values:
            state, reason = "credential_required", "No compatible credential configured"
        elif statuses:
            state, reason = "unavailable", statuses[0][1] or "No Connect method available on this operating system"
        else:
            state, reason = "unavailable", "No Connect method available for this device yet"
        out.append(ConnectStatusOut(
            device_id=device_id,
            platform=platform_id,
            state=state,
            reason=reason,
            preferred_method_id=preferred_id,
            preferred_method_label=by_id[preferred_id].label if preferred_id and preferred_id in by_id else None,
            method_count=len(methods),
        ))
    return out


class ConnectPreferenceIn(BaseModel):
    platform: str
    method_id: str
    device_id: Optional[int] = None


class ConnectPreferenceOut(BaseModel):
    platform: str
    device_id: Optional[int] = None
    method_id: str


class ConnectPreferenceResetIn(BaseModel):
    platform: str
    device_id: Optional[int] = None


@router.get("/connect-preferences", response_model=List[ConnectPreferenceOut])
def list_connect_preferences(
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
):
    """Section G "settings to view/reset defaults" — always the CALLING
    operator's own preferences (never global, never another operator's)."""
    prefs = ConnectPreferenceService(db).list_preferences(operator.id)
    return [ConnectPreferenceOut(platform=p.platform, device_id=p.device_id, method_id=p.method_id) for p in prefs]


@router.put("/connect-preferences", response_model=ConnectPreferenceOut)
def set_connect_preference(
    payload: ConnectPreferenceIn,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
):
    """"Always use this method" — sets a per-operator+platform default, or a
    per-operator+device override when `device_id` is given."""
    pref = ConnectPreferenceService(db).set_preference(
        operator.id, payload.platform, payload.method_id, device_id=payload.device_id,
    )
    return ConnectPreferenceOut(platform=pref.platform, device_id=pref.device_id, method_id=pref.method_id)


@router.delete("/connect-preferences", status_code=204)
def reset_connect_preference(
    payload: ConnectPreferenceResetIn,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
):
    ConnectPreferenceService(db).reset_preference(operator.id, payload.platform, device_id=payload.device_id)
    return None


class ConnectCredentialResponse(BaseModel):
    """The stored credential for a Connect method, handed to the operator so
    they can sign in to WebFig/Winbox, which have no automated login."""
    username: Optional[str] = None
    password: Optional[str] = None
    credential_name: str
    credential_source: str  # Vault scope tier the credential resolved from


class ConnectLaunchResponse(BaseModel):
    url: str
    surface: str  # desktop | browser — tells the frontend how to open `url`
    # True when the URL is plain http, i.e. anything typed into that page —
    # including the router password — crosses the network unencrypted. The
    # caller is expected to say so rather than open it silently.
    insecure: bool = False


@router.get("/devices/{device_id}/connect-methods/{method_id}/launch", response_model=ConnectLaunchResponse)
def device_connect_launch(
    device_id: int,
    method_id: str,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _perm: None = Depends(require_team_permission(REMOTE_SUPPORT_CONNECT)),
):
    """Build the launch URL for a Connect method — generic for every platform:
    `scheme://<host>` for desktop methods (Winbox, SSH…), `http://<host><web_path>`
    for browser methods (WebFig…). `remote_support`/`web_terminal` keep their own
    dedicated endpoints and are rejected here."""
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    available = {m.id: m for m in methods_for(platform_id, device.capabilities)}
    method = available.get(method_id)
    if method is None:
        raise HTTPException(status_code=404, detail="Connect method not available for this device")
    if method.id in _DEDICATED_METHOD_IDS:
        raise HTTPException(status_code=400, detail=f"'{method.id}' uses its own connect flow, not the generic launcher")

    host = resolve_connect_host(device, platform_id)
    if not host:
        raise HTTPException(status_code=409, detail="Device has no known IP address yet")

    port = device.connect_port or credential_port(db, device, method.id)
    insecure = False

    if method.scheme:
        # Desktop schemes (winbox://, ssh://) carry their own transport
        # security; there is no plaintext variant to warn about.
        authority = f"{host}:{port}" if port else host
        url = f"{method.scheme}{authority}"
    else:
        # RouterOS serves WebFig on `www` (80) and `www-ssl` (443). The URL was
        # previously hardcoded to http://, so a login over a public address sent
        # the router password across the internet in the clear and there was no
        # way to ask for TLS at all. Port 443 now selects https, which is what
        # makes an encrypted WebFig reachable in the first place.
        #
        # http remains the fallback rather than the default being flipped:
        # RouterOS ships www-ssl DISABLED, so defaulting to https would break
        # every router that has not enabled it. `insecure` is returned so the
        # caller can say plainly that this session is unencrypted instead of
        # the platform quietly handing over a plaintext link.
        scheme = "https" if port == 443 else "http"
        default_port = 443 if scheme == "https" else 80
        authority = f"{host}:{port}" if port and port != default_port else host
        url = f"{scheme}://{authority}{method.web_path or '/'}"
        insecure = scheme == "http"

    audit_log(
        db,
        operator=operator,
        action=AuditAction.REMOTE_CONNECT,
        entity_type="device",
        entity_id=device_id,
        details={"method": method.id, "platform": platform_id, "surface": method.surface,
                 "insecure": insecure},
    )

    return ConnectLaunchResponse(url=url, surface=method.surface, insecure=insecure)


class DrawerActionOut(BaseModel):
    id: str
    label: str
    permission: Optional[str] = None
    required_capability: Optional[str] = None
    confirm: str
    target: str


class DrawerMetaResponse(BaseModel):
    """The single feed the registry-driven Device Drawer renders from: the
    device's effective capabilities, its Connect methods, its available Actions
    and its capability-driven tabs — all derived from the Platform / Capability /
    Connect / Action registries. Windows (no reported capabilities) resolves to
    its declared surface, so its Drawer is unchanged."""
    platform: str
    capabilities: List[str]
    remote_support: bool          # show the Remote Support tab
    terminal: bool                # show the Terminal tab
    capability_tabs: List[str]    # dynamic tabs (services/docker/logs/…)
    connect_methods: List[ConnectMethodOut]
    actions: List[DrawerActionOut]
    # Version Service (reused, not reimplemented per platform): the device's
    # reported connector/agent version, the platform's latest, and the
    # current/outdated/ahead status the badge renders from. None for Windows
    # (its classic Drawer has its own separate, untouched badge mechanism).
    reported_version: Optional[str] = None
    latest_version: Optional[str] = None
    version_status: Optional[str] = None


@router.get("/devices/{device_id}/drawer", response_model=DrawerMetaResponse)
def device_drawer_meta(
    device_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
):
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    eff = effective_capabilities(device.platform, device.capabilities)
    methods = methods_for(platform_id, device.capabilities)
    actions = actions_for(device.platform, device.capabilities)

    latest_version = (
        version_service.get_active_version(platform_id, device.architecture)
        if platform_id != "windows"
        else None
    )
    version_status = version_service.compare_versions(device.agent_version, latest_version) if latest_version else None

    return DrawerMetaResponse(
        platform=platform_id,
        capabilities=sorted(eff),
        remote_support="remote_support" in eff,
        terminal="terminal" in eff,
        capability_tabs=capability_tabs(eff),
        connect_methods=[
            ConnectMethodOut(id=m.id, label=m.label, surface=m.surface,
                             capability=m.capability, priority=m.priority, scheme=m.scheme,
                             requires_client_os=m.requires_client_os,
                             transport=m.transport, category=m.category, embedded=m.embedded)
            for m in methods
        ],
        actions=[
            DrawerActionOut(id=a.id, label=a.label, permission=a.permission,
                            required_capability=a.required_capability,
                            confirm=a.confirm, target=a.target)
            for a in actions
        ],
        reported_version=device.agent_version,
        latest_version=latest_version,
        version_status=version_status,
    )


@router.post(
    "/devices/{device_id}/connect-methods/{method_id}/credential",
    response_model=ConnectCredentialResponse,
)
def device_connect_credential(
    device_id: int,
    method_id: str,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_vault_reveal),
    _perm: None = Depends(require_team_permission(REMOTE_SUPPORT_CONNECT)),
):
    """Hand the operator the stored credential for a Connect method.

    WebFig and Winbox have no automated login, so the operator types the
    credential themselves. That makes this a **reveal** — a human reads the
    plaintext — not a machine "use", and it is deliberately treated as one:

      * `_require_vault_reveal` is the Vault's own gate, imported rather than
        re-implemented so a security check can never drift between two copies.
        Holding `remote_support_connect` alone is NOT enough — otherwise every
        operator who can click Connect could extract stored passwords, which
        would quietly hollow out the Vault's reveal permission.
      * `VaultService.reveal()` writes the 'reveal' usage row and the VAULT
        REVEAL warning log, and an audit record is written here, exactly like
        POST /vault/{id}/reveal.

    The reason is generated rather than prompted. An operator typing free text
    on every connect would add friction and produce worse evidence than a
    generated line naming the method and device, which is precise and cannot be
    left blank.
    """
    if not feature_enabled("FEATURE_PLATFORM_CORE"):
        raise HTTPException(status_code=404, detail="Not Found")

    device = DeviceRepository(db).get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    descriptor = resolve_platform(device.platform)
    platform_id = descriptor.id if descriptor is not None else "windows"
    if method_id not in {m.id for m in methods_for(platform_id, device.capabilities)}:
        raise HTTPException(status_code=404, detail="Connect method not available for this device")

    service = VaultService(db)
    tier, candidates = service.resolve_credentials_for_method(device, method_id)
    if not candidates:
        raise HTTPException(status_code=409, detail="No credential configured for this method")

    credential = candidates[0]
    reason = f"Connect: {method_id} on device #{device_id}"
    secret_fields = service.reveal(credential, operator.username, reason)

    audit_log(
        db,
        operator=operator,
        action="vault_credential_revealed",
        entity_type="vault_credential",
        entity_id=credential.id,
        details={"name": credential.name, "reason": reason,
                 "method": method_id, "device_id": device_id},
    )

    return ConnectCredentialResponse(
        username=credential.username,
        password=secret_fields.get("password") or secret_fields.get("secret"),
        credential_name=credential.name,
        credential_source=tier,
    )
