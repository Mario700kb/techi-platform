import json
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response, status
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.responses import JSONResponse

from app.api.v1.endpoints.agent import agent_heartbeat
from app.db.session import get_db
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import AgentHeartbeatPayload

router = APIRouter()
logger = logging.getLogger("techi.legacy_compat")

_MAX_LEGACY_BODY_BYTES = 1024 * 1024


async def _read_limited_body(request: Request) -> Optional[bytes]:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_LEGACY_BODY_BYTES:
            logger.info("Ignoring oversized legacy heartbeat body")
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

    try:
        payload = AgentHeartbeatPayload.model_validate(raw_payload)
    except ValidationError:
        logger.debug("Ignoring incompatible legacy heartbeat")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    if not _resolves_existing_device(payload, db):
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
        response = agent_heartbeat(payload, background_tasks, db)
        await background_tasks()
    except Exception as exc:
        db.rollback()
        logger.info("Ignoring legacy heartbeat that could not be processed: %s", type(exc).__name__)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return JSONResponse(content=jsonable_encoder(response))


@router.api_route("/api/sysinfo", methods=["GET", "POST"])
async def sysinfo_legacy() -> Response:
    logger.debug("Ignoring legacy sysinfo request")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
