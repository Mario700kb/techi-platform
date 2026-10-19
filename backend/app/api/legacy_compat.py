import json
import logging
import threading
import time
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response, status
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, PlainTextResponse

from app.api.v1.endpoints.agent import agent_heartbeat
from app.core.agent_auth import _SlidingWindowRateLimiter
from app.db.session import get_db
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import AgentHeartbeatPayload
from app.services.remote_support_presence import RemoteSupportPresence, is_remote_support_report, parse_report

router = APIRouter()
logger = logging.getLogger("techi.legacy_compat")

_MAX_LEGACY_BODY_BYTES = 1024 * 1024
# Remote Support reports carry no credential: each address gets a ceiling on
# the reports that reach the database (a known client never does). An office
# of 50 machines restarting at once stays well under it.
presence_limiter = _SlidingWindowRateLimiter(limit=240, window_seconds=60)
# After a restart every client (~1,000) is unknown to the memory cache at once,
# just as every agent reconnects. Reports are answered {} without the database
# for the first minutes, then at most two at a time reach it; an answered-{}
# client simply reports again 15 s later.
PRESENCE_STARTUP_GRACE_S = 180
_presence_slots = threading.BoundedSemaphore(2)
_started_at = time.monotonic()


def _presence_slot() -> bool:
    if time.monotonic() - _started_at < PRESENCE_STARTUP_GRACE_S:
        return False
    return _presence_slots.acquire(blocking=False)


async def _read_limited_body(request: Request) -> Optional[bytes]:
    body = bytearray()
    try:
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > _MAX_LEGACY_BODY_BYTES:
                logger.info("Ignoring oversized legacy heartbeat body")
                return None
    except ClientDisconnect:
        # Leftover legacy agents fire heartbeats with tiny timeouts and hang
        # up without waiting; thousands per minute. Not an error — drop them
        # quietly instead of spamming a full traceback per request.
        return None
    return bytes(body)


def _resolves_existing_device(payload: AgentHeartbeatPayload, db: Session) -> bool:
    repository = DeviceRepository(db)
    resolved_ids = set()

    if payload.device_id is not None:
        device = repository.get(payload.device_id)
        if device is not None:
            resolved_ids.add(device.id)
    if payload.agent_id:
        device = repository.get_by_agent_id(payload.agent_id)
        if device is not None:
            resolved_ids.add(device.id)
    if payload.rustdesk_id:
        device = repository.get_by_rustdesk_id(payload.rustdesk_id)
        if device is not None:
            resolved_ids.add(device.id)

    return len(resolved_ids) == 1


@router.post("/api/heartbeat")
async def heartbeat_legacy(request: Request, db: Session = Depends(get_db)):
    body = await _read_limited_body(request)
    if not body:
        logger.debug("Ignoring empty legacy heartbeat")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    try:
        raw_payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.debug("Ignoring malformed legacy heartbeat")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    if not isinstance(raw_payload, dict):
        logger.debug("Ignoring non-object legacy heartbeat")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # TECHI Remote Support's own heartbeat ({id, uuid}, every 15 s from each
    # client) arrives here too: it tells the platform the ID in the client's
    # window. Answered from memory unless something changed.
    if is_remote_support_report(raw_payload):
        return await _remote_support_heartbeat(raw_payload, request, db)

    try:
        payload = AgentHeartbeatPayload.model_validate(raw_payload)
    except ValidationError:
        logger.debug("Ignoring incompatible legacy heartbeat")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # The database work runs in the threadpool: on the event loop a wait for a
    # pool connection (up to pool_timeout) froze every request, health included
    # (2026-10-13 15:24 outage).
    if not await run_in_threadpool(_resolves_existing_device, payload, db):
        logger.debug("Ignoring legacy heartbeat without an existing device identity")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    try:
        # agent_heartbeat defers side effects (telemetry, inventory, actions
        # bookkeeping) to BackgroundTasks; run them inline here so legacy
        # devices get the same processing as the v1 route. Calling with the
        # wrong signature would raise, return a bodyless 204, and old agents
        # would treat every heartbeat as failed and hammer this endpoint in a
        # tight retry loop (2026-07-03 CPU incident).
        background_tasks = BackgroundTasks()
        response = await run_in_threadpool(agent_heartbeat, payload, request, background_tasks, db)
        await background_tasks()
    except Exception as exc:
        db.rollback()
        logger.info("Ignoring legacy heartbeat that could not be processed: %s", type(exc).__name__)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return JSONResponse(content=jsonable_encoder(response))


async def _remote_support_heartbeat(raw_payload: dict, request: Request, db: Session) -> Response:
    rustdesk_id, uuid = parse_report(raw_payload)
    source_ip = request.client.host if request.client else None
    answer = RemoteSupportPresence.fast_heartbeat(rustdesk_id, uuid, source_ip)
    if answer is None:
        # A new client, a new ID or a new address: the database decides.
        if not presence_limiter.is_allowed(source_ip or "unknown") or not _presence_slot():
            return JSONResponse(content={})
        try:
            answer = await run_in_threadpool(
                RemoteSupportPresence(db).heartbeat, rustdesk_id, uuid, source_ip, raw_payload.get("ver")
            )
        except Exception:
            db.rollback()
            logger.warning("Remote Support heartbeat could not be stored", exc_info=True)
            answer = {}
        finally:
            _presence_slots.release()
    return JSONResponse(content=answer)


@router.api_route("/api/sysinfo", methods=["GET", "POST"])
async def sysinfo_legacy(request: Request, db: Session = Depends(get_db)) -> Response:
    """TECHI Remote Support's system info (hostname, user, OS), sent when it
    changes until the answer is SYSINFO_UPDATED."""
    if request.method != "POST":
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    body = await _read_limited_body(request)
    try:
        raw_payload = json.loads(body) if body else None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raw_payload = None
    if parse_report(raw_payload) is None:
        logger.debug("Ignoring legacy sysinfo request")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    source_ip = request.client.host if request.client else None
    if not presence_limiter.is_allowed(source_ip or "unknown") or not _presence_slot():
        return PlainTextResponse("")  # the client sends it again in two minutes
    try:
        answer = await run_in_threadpool(RemoteSupportPresence(db).sysinfo, raw_payload, source_ip)
    except Exception:
        db.rollback()
        logger.warning("Remote Support sysinfo could not be stored", exc_info=True)
        answer = ""
    finally:
        _presence_slots.release()
    return PlainTextResponse(answer)
