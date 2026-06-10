# TECHI Platform Runbook

This index links the primary operational and architecture notes for common
platform administration tasks.

## Heartbeat Interval

- [Heartbeat Interval Architecture](architecture/heartbeat-interval.md)

Use this guide when changing agent heartbeat cadence or reviewing online,
stale, and offline thresholds.

## Agent Config

- Backend policy endpoint: `GET` and `PUT /api/v1/agent-config`
- Rollout script endpoint: `GET /api/v1/agent-config/heartbeat-script`
- Implementation: `backend/app/services/agent_config_service.py`

Agent configuration changes require admin or owner access. Validate heartbeat
threshold compatibility before rollout.

## Enrollment Audit

- [Enrollment Audit Architecture](architecture/enrollment-audit.md)

Use this guide to understand audit event storage, result types, legacy
inference, performance, and security behavior.

## Token Diagnostics

- [Token Diagnostics Operations Guide](operations/token-diagnostics.md)

Use this guide to reconcile token uses with unique devices, duplicate
enrollments, failures, archived devices, and orphaned uses.
