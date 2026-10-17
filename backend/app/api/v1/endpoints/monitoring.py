"""Monitoring: policies, a device's metrics and monitors, a client's analytics,
and the health of the telemetry pipeline."""
import asyncio
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.v1.endpoints.devices import get_scoped_device
from app.core.auth import get_current_operator, get_operator_scope, require_min_role
from app.core.scope import AllowedScope, device_in_scope
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.operator import Operator, OperatorRole
from app.schemas.telemetry_pipeline import (
    ClientMonitoring,
    DeviceMetrics,
    DeviceMonitoring,
    PipelineHealth,
    PolicyBody,
    PolicyOut,
    Range,
)
from app.services.audit_service import AuditAction, audit_log
from app.services.metrics_query_service import MetricsQueryService
from app.services.monitoring_policy_service import MonitoringPolicyService, agent_policy_payload, effective_policy

logger = logging.getLogger(__name__)
router = APIRouter()
_require_admin = require_min_role(OperatorRole.ADMIN.value)


# ── policies ────────────────────────────────────────────────────────────────

def _push_policies(db: Session, device_ids: List[int]) -> int:
    """Send the new effective policy to every affected agent with an open live
    channel; the rest pick it up from their next heartbeat."""
    from app.websocket.agent_channel import agent_command_channel, get_main_loop

    loop = get_main_loop()
    if loop is None:
        return 0
    pushed = 0
    for device_id in device_ids:
        if not agent_command_channel.is_connected(device_id):
            continue
        device = db.get(Device, device_id)
        if device is None:
            continue
        payload = {"type": "policy", "policy": agent_policy_payload(effective_policy(db, device))}
        try:
            if asyncio.run_coroutine_threadsafe(agent_command_channel.push(device_id, payload), loop).result(timeout=2):
                pushed += 1
        except Exception:
            logger.info("monitoring: policy push to device %s failed; the heartbeat will deliver it", device_id)
    return pushed


@router.get("/monitoring/policies", response_model=List[PolicyOut])
def list_policies(db: Session = Depends(get_db), _: Operator = Depends(get_current_operator)):
    return MonitoringPolicyService(db).list()


@router.post("/monitoring/policies", response_model=PolicyOut, status_code=201)
def create_policy(body: PolicyBody, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    service = MonitoringPolicyService(db)
    try:
        policy = service.create(body, operator.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.MONITORING_POLICY_CREATED, entity_type="monitoring_policy",
              entity_id=policy.id, details={"name": policy.name, "scope": policy.scope, "scope_value": policy.scope_value})
    _push_policies(db, service.devices_for(policy))
    return next(p for p in service.list() if p.id == policy.id)


@router.put("/monitoring/policies/{policy_id}", response_model=PolicyOut)
def update_policy(policy_id: int, body: PolicyBody, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    service = MonitoringPolicyService(db)
    policy = service.get(policy_id)
    if policy is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    before = set(service.devices_for(policy))
    try:
        policy = service.update(policy, body, operator.username)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.MONITORING_POLICY_UPDATED, entity_type="monitoring_policy",
              entity_id=policy.id, details={"name": policy.name, "version": policy.version})
    _push_policies(db, sorted(before | set(service.devices_for(policy))))
    return next(p for p in service.list() if p.id == policy.id)


@router.delete("/monitoring/policies/{policy_id}", status_code=204)
def delete_policy(policy_id: int, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    service = MonitoringPolicyService(db)
    policy = service.get(policy_id)
    if policy is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    affected = service.devices_for(policy)
    name = policy.name
    try:
        service.delete(policy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.MONITORING_POLICY_DELETED, entity_type="monitoring_policy",
              entity_id=policy_id, details={"name": name})
    _push_policies(db, affected)


@router.get("/monitoring/pipeline", response_model=PipelineHealth)
def pipeline_health(db: Session = Depends(get_db), _: Operator = Depends(_require_admin)):
    return MetricsQueryService(db).pipeline_health()


# ── a device ────────────────────────────────────────────────────────────────

@router.get("/devices/{device_id}/metrics", response_model=DeviceMetrics)
def device_metrics(range: Range = Query(default="24h"), device: Device = Depends(get_scoped_device),
                   db: Session = Depends(get_db)):
    return MetricsQueryService(db).device_metrics(device, range)


@router.get("/devices/{device_id}/monitoring", response_model=DeviceMonitoring)
def device_monitoring(device: Device = Depends(get_scoped_device), db: Session = Depends(get_db)):
    return MetricsQueryService(db).device_monitoring(device)


# ── a client ────────────────────────────────────────────────────────────────

@router.get("/clients/{client_id}/monitoring", response_model=ClientMonitoring)
def client_monitoring(
    client_id: int,
    range: Range = Query(default="7d"),
    db: Session = Depends(get_db),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    if range == "1h":
        range = "24h"
    if db.get(Client, client_id) is None:
        raise HTTPException(status_code=404, detail="Client not found")
    devices = [
        d for d in db.query(Device).filter(Device.client_id == client_id, Device.is_archived.is_(False)).all()
        if device_in_scope(d.client_id, d.group_id, d.id, scope)
    ]
    if scope is not None and not devices:
        raise HTTPException(status_code=404, detail="Client not found")
    return MetricsQueryService(db).client_monitoring(devices, range)
