import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse

from app.db.session import get_db
from app.repositories.device_repository import DeviceRepository
from app.schemas.agent import AgentHeartbeatPayload

router = APIRouter()
logger = logging.getLogger("techi.legacy_compat")

_MAX_LEGACY_BODY_BYTES = 1024 * 1024


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

    try:
        payload = AgentHeartbeatPayload.model_validate(raw_payload)
    except ValidationError:
        logger.debug("Ignoring incompatible legacy heartbeat")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    if not _resolves_existing_device(payload, db):
        logger.debug("Ignoring legacy heartbeat without an existing device identity")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Numeric IDs and Remote IDs are not authentication. Known legacy Agents
    # get an explicit migration response, but no heartbeat mutation, pending
    # action, or Remote Support credential is disclosed.
    return JSONResponse(
        status_code=status.HTTP_428_PRECONDITION_REQUIRED,
        content={
            "detail": "Agent re-enrollment is required before authenticated heartbeats can resume",
            "authentication_required": True,
        },
    )


@router.api_route("/api/sysinfo", methods=["GET", "POST"])
async def sysinfo_legacy() -> Response:
    logger.debug("Ignoring legacy sysinfo request")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
