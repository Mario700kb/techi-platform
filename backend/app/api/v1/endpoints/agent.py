import logging
import secrets
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.core.agent_auth import _SlidingWindowRateLimiter, enroll_limiter
from app.core.config import settings
from app.db.session import get_db, SessionLocal
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import (
    AgentEnrollmentRequest,
    AgentEnrollmentResponse,
    AgentHeartbeatPayload,
    AgentHeartbeatResponse,
    AgentPowerEventPayload,
)
from app.services import agent_config_service as _cfg_svc
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.device_status_service import DeviceStatusService
from app.services.remote_action_service import RemoteActionService
from app.schemas.telemetry_pipeline import TelemetryAck, TelemetryUpload
from app.services.monitoring_policy_service import agent_policy_payload, effective_policy
from app.services.telemetry_ingest_service import TelemetryIngestService
from app.services.remote_support_password_service import RemoteSupportPasswordService

logger = logging.getLogger(__name__)

router = APIRouter()


def _agent_id_matches(provided: Optional[str], stored: Optional[str]) -> bool:
    """True when the heartbeat carries this device's own agent_id.

    compare_digest so the comparison does not leak the stored value through
    timing. Both sides must be non-empty: a device with no agent_id on record
    must never be unlocked by a caller that also omits it.
    """
    provided = (provided or "").strip()
    stored = (stored or "").strip()
    if not provided or not stored:
        return False
    return secrets.compare_digest(provided, stored)


def _normalize_public_backend_url(request: Request) -> str:
    configured_url = (settings.PUBLIC_BACKEND_URL or "").strip().rstrip("/")
    raw = configured_url or str(request.base_url).strip().rstrip("/")
    parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
    return urlunsplit(("https", parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _public_websocket_url(base_url: str) -> str:
    parsed = urlsplit(base_url if "://" in base_url else f"https://{base_url}")
    return urlunsplit(("wss", parsed.netloc, "/ws/devices", "tenant_id=default", ""))


def _heartbeat_side_effects(
    payload: AgentHeartbeatPayload,
    device_id: int,
    heartbeat_id: int,
    ctx: dict,
) -> None:
    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is None:
            return
        DeviceHeartbeatService(db)._run_side_effects(payload, device, heartbeat_id, ctx)
    except Exception:
        logger.exception("heartbeat side-effects failed for device %d", device_id)
    finally:
        db.close()


@router.post("/enroll", response_model=AgentEnrollmentResponse)
def agent_enroll(
    payload: AgentEnrollmentRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """
    First-run enrollment handshake for agents with a one-time enrollment token.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not enroll_limiter.is_allowed(client_ip):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many enrollment attempts")
    if not payload.public_ip and request.client:
        payload = payload.model_copy(update={"public_ip": request.client.host})
    base_url = _normalize_public_backend_url(request)
    websocket_url = _public_websocket_url(base_url)
    service = AgentEnrollmentService(db)
    try:
        return service.enroll(
            payload,
            heartbeat_url=f"{base_url}/api/v1/agent/heartbeat",
            websocket_url=websocket_url,
        )
    except ValueError as exc:
        detail = str(exc)
        if detail == "used":
            raise HTTPException(status_code=400, detail="Enrollment token exhausted, max_uses reached")
        if detail in {"invalid", "expired", "revoked"}:
            raise HTTPException(status_code=400, detail=f"Enrollment token is {detail}")
        if "enrollment_token is required" in detail or "not trusted" in detail:
            raise HTTPException(status_code=403, detail=detail)
        raise HTTPException(status_code=400, detail=detail)


def _monitoring_policy(db: Session, device) -> Optional[dict]:
    """The heartbeat never fails because monitoring could not be read: the
    agent keeps the policy it has and gets the next one later."""
    try:
        return agent_policy_payload(effective_policy(db, device))
    except Exception:
        logger.exception("heartbeat: monitoring policy for device %s could not be read", device.id)
        db.rollback()
        return None


@router.post("/heartbeat", response_model=AgentHeartbeatResponse)
def agent_heartbeat(
    payload: AgentHeartbeatPayload,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Agent heartbeat endpoint. Returns immediately after writing the device record;
    telemetry, inventory, alerts, and realtime events run in a background task.
    """
    # Agents from 2.1.25 send no public IP (it came from api.ipify.org):
    # the address the request arrives from is the one that counts. uvicorn
    # takes it from X-Forwarded-For only when the proxy (FORWARDED_ALLOW_IPS)
    # sent it, so a caller cannot choose it with its own header.
    if not payload.public_ip and request.client:
        payload = payload.model_copy(update={"public_ip": request.client.host})

    service = DeviceHeartbeatService(db)
    try:
        device, heartbeat, ctx = service.process_heartbeat_core(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    background_tasks.add_task(_heartbeat_side_effects, payload, device.id, heartbeat.id, ctx)

    # Does the caller prove it knows this device's agent_id? Device resolution
    # above is deliberately left untouched — a heartbeat is still processed in
    # full whether or not the caller authenticates — but the two pieces of the
    # response that are attacker-usable are withheld unless this holds. Without
    # it the endpoint is public, unauthenticated, and resolves the device from a
    # caller-supplied sequential device_id (RISK-SEC-002). agent_id is
    # secrets.token_urlsafe(18) — 144 bits — so this turns enumeration into an
    # infeasible guess. It is a knowledge barrier, not authentication: agent_id
    # is a non-expiring bearer secret readable by a local administrator, and is
    # the bridge to the RSA challenge/response in AgentAuthMigrationService, not
    # a replacement for it.
    authenticated = _agent_id_matches(payload.agent_id, getattr(device, "agent_id", None))

    # Pending remote-action delivery is destructive: collect_pending_for_delivery
    # marks each returned action SENT so it is never re-delivered. An
    # unauthenticated caller could therefore not only read every pending action's
    # payload and callback_secret (set_remote_password, run_powershell, …) but
    # also mark them SENT, starving the real device while reporting them complete
    # via the leaked callback token. So it only runs for an authenticated caller;
    # everyone else gets an empty list and nothing is marked SENT.
    pending_actions = (
        RemoteActionService(db).collect_pending_for_delivery(device.id)
        if authenticated
        else []
    )
    interval = _cfg_svc.get_heartbeat_interval(payload.platform)

    # Server-authoritative per-device RS password. Generated on first use and
    # returned every heartbeat so a >= 2.1.5 agent applies/self-heals it. Same
    # gate as pending actions above.
    rs_password = (
        RemoteSupportPasswordService(db).get_or_create(device) if authenticated else None
    )

    response = {
        "device_id": device.id,
        "heartbeat_id": heartbeat.id,
        # The Remote Support ID is what an operator connects to; a caller that
        # names a device without its agent_id must not learn it. The agent never
        # reads it from here (it reports its own).
        "rustdesk_id": device.rustdesk_id if authenticated else None,
        "device_type": device.device_type,
        "status": device.status,
        "last_seen": device.last_seen,
        "heartbeat_at": heartbeat.created_at,
        "pending_actions": [a.model_dump() for a in pending_actions],
        "heartbeat_interval_seconds": interval,
        "agent_update": None,  # populated in Faza 3 when agent-packages service is ready
        "remote_support_password": rs_password,
        "monitoring_policy": _monitoring_policy(db, device) if authenticated else None,
    }
    # Hand the connection back before the side effects open their own session.
    # get_db would only close it after them, so every heartbeat held two pool
    # connections at once and a burst (all agents after a restart) exhausted the
    # pool with each request waiting on a second connection.
    db.close()
    return response


@router.post("/power-event", status_code=status.HTTP_204_NO_CONTENT)
def agent_power_event(payload: AgentPowerEventPayload, db: Session = Depends(get_db)):
    """
    Last message from an agent whose machine is shutting down or going to sleep.

    Marks the device offline at once, recording why, so the stale-heartbeat
    reconciliation never sees it and never raises a critical offline alert.
    Unlike the heartbeat this requires a matching agent_id: an unauthenticated
    caller could otherwise silence the offline alert of any device it names.
    A missing device and a wrong agent_id get the same 403.
    """
    device = DeviceRepository(db).get(payload.device_id)
    if device is None or not _agent_id_matches(payload.agent_id, device.agent_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Unknown device or agent_id")
    DeviceStatusService(db).mark_offline_from_power_event(device, payload.state)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── telemetry uploads (agent >= 2.1.29) ─────────────────────────────────────

# An agent uploads every 15 minutes, in chunks after an outage; this is far
# above that and only stops a misbehaving one.
_telemetry_limiter = _SlidingWindowRateLimiter(limit=30, window_seconds=60)
_MAX_TELEMETRY_BYTES = 4 * 1024 * 1024  # decompressed


@router.post("/telemetry", response_model=TelemetryAck)
async def agent_telemetry(request: Request):
    """Store a batch of the device's samples exactly once and acknowledge the
    highest sequence number, so the agent can drop them from its buffer.

    The body may be gzip-compressed (Content-Encoding: gzip). The caller must
    present the device's own agent_id, like a power event: a missing device
    and a wrong agent_id get the same 403."""
    import gzip
    import io
    import json

    from fastapi.concurrency import run_in_threadpool
    from pydantic import ValidationError

    raw = await request.body()
    if request.headers.get("content-encoding", "").lower() == "gzip":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                raw = stream.read(_MAX_TELEMETRY_BYTES + 1)
        except OSError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body is not valid gzip")
    if len(raw) > _MAX_TELEMETRY_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Upload too large")
    try:
        upload = TelemetryUpload.model_validate(json.loads(raw))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)[:500])
    if not _telemetry_limiter.is_allowed(f"device:{upload.device_id}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many uploads")

    def store() -> TelemetryAck:
        db = SessionLocal()
        try:
            device = DeviceRepository(db).get(upload.device_id)
            if device is None or not _agent_id_matches(upload.agent_id, device.agent_id):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Unknown device or agent_id")
            policy = effective_policy(db, device)
            return TelemetryIngestService(db).ingest(device, upload, policy)
        finally:
            db.close()

    return await run_in_threadpool(store)
