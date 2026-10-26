"""Rules the database enforces on top of the application's validation.

Only for configuration and bookkeeping columns: telemetry is never checked
here, because one out-of-range reading would reject the agent's whole upload.
Attached to the tables at import (tests on SQLite enforce them too); the
PostgreSQL migration a5b6c7d8e9f0 created them in production.
"""
from sqlalchemy import CheckConstraint

from app.db.base import Base

CHECKS = {
    "devices": {
        # Trash is an archived device that was deleted (DeviceService.trash_device).
        "ck_devices_trash_is_archived": "deleted_at IS NULL OR is_archived",
        "ck_devices_archived_at": "is_archived = (archived_at IS NOT NULL)",
        "ck_devices_connect_port": "connect_port BETWEEN 1 AND 65535",
        "ck_devices_duplicate_score": "duplicate_score BETWEEN 0 AND 1",
        "ck_devices_counts": "enrollment_count >= 0 AND rustdesk_repair_count >= 0",
    },
    "monitoring_policies": {
        "ck_monitoring_policies_sample_seconds": "sample_seconds BETWEEN 10 AND 3600",
        "ck_monitoring_policies_upload_seconds": "upload_seconds BETWEEN 60 AND 3600",
        "ck_monitoring_policies_buffer_mb": "buffer_mb > 0",
        "ck_monitoring_policies_keep_days": "keep_days > 0",
    },
    "automation_tasks": {
        "ck_automation_tasks_max_failure_percent": "max_failure_percent BETWEEN 0 AND 100",
        "ck_automation_tasks_wave_wait_minutes": "wave_wait_minutes >= 0",
        "ck_automation_tasks_window_minutes": "window_minutes > 0",
    },
    "notification_rules": {"ck_notification_rules_cooldown_seconds": "cooldown_seconds >= 0"},
    "notification_deliveries": {"ck_notification_deliveries_attempt_count": "attempt_count >= 0"},
    "report_schedules": {"ck_report_schedules_period_days": "period_days BETWEEN 1 AND 366"},
    "report_runs": {"ck_report_runs_size_bytes": "size_bytes >= 0"},
    "agent_command_batches": {"ck_agent_command_batches_timeout_seconds": "timeout_seconds > 0"},
    "remote_actions": {"ck_remote_actions_execution_timeout_seconds": "execution_timeout_seconds > 0"},
    "device_alerts": {"ck_device_alerts_sla_paused_minutes": "sla_paused_minutes >= 0"},
    "enrollment_tokens": {"ck_enrollment_tokens_use_count": "use_count >= 0"},
    "revoked_agents": {"ck_revoked_agents_attempt_count": "attempt_count >= 0"},
}


def attach_checks() -> None:
    for table_name, checks in CHECKS.items():
        table = Base.metadata.tables[table_name]
        existing = {c.name for c in table.constraints}
        for name, expression in checks.items():
            if name not in existing:
                table.append_constraint(CheckConstraint(expression, name=name))
