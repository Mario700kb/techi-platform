from app.models.agent_command_batch import AgentCommandBatch
from app.models.automation import AutomationRun, AutomationTask
from app.models.alert import AlertActivity, AlertAnalysis, AlertDutyShift, AlertMute, DeviceAlert
from app.models.client import Client
from app.models.client_document import ClientDocument
from app.models.client_location import ClientLocation, ClientLocationRule
from app.models.connect_preference import OperatorConnectPreference
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.device_activity_event import DeviceActivityEvent
from app.models.device_heartbeat import DeviceHeartbeat
from app.models.device_inventory import DeviceInventory
from app.models.device_note import DeviceNote
from app.models.device_status_history import DeviceStatusHistory
from app.models.device_telemetry import DeviceTelemetry
from app.models.enrollment_token import EnrollmentToken
from app.models.enrollment_audit import EnrollmentAudit
from app.models.notification import NotificationChannel, NotificationDelivery, NotificationRule
from app.models.report import ReportRun, ReportSchedule
from app.models.operator import Operator
from app.models.operator_session import OperatorSession
from app.models.remote_action import RemoteAction
from app.models.reenrollment_request import ReenrollmentRequest
from app.models.revoked_agent import RevokedAgent
from app.models.telemetry_pipeline import (
    DeviceTelemetryState,
    MonitoringPolicy,
    TelemetryRollup1h,
    TelemetryRollup5m,
    TelemetrySample,
)
from app.models.remote_support_connection import RemoteSupportConnection
from app.models.remote_support_peer import RemoteSupportPeer
from app.models.team import Team, TeamClientAccess, TeamDeviceAccess, TeamGroupAccess, TeamMember
from app.models.trusted_domain import TrustedDomain
from app.models.terminal_session import TerminalSession
from app.models.console_script import ConsoleScript
from app.models.vault_credential import VaultCredential, VaultCredentialAssignment, VaultCredentialUsage

__all__ = [
    "AutomationRun",
    "AutomationTask",
    "Team",
    "TeamClientAccess",
    "TeamDeviceAccess",
    "TeamGroupAccess",
    "TeamMember",
    "OperatorSession",
    "AgentCommandBatch",
    "Client",
    "ClientDocument",
    "ConsoleScript",
    "ClientLocation",
    "ClientLocationRule",
    "Device",
    "AlertActivity",
    "AlertAnalysis",
    "AlertDutyShift",
    "AlertMute",
    "DeviceAlert",
    "RemoteSupportPeer",
    "DeviceGroup",
    "DeviceActivityEvent",
    "DeviceHeartbeat",
    "DeviceInventory",
    "DeviceNote",
    "DeviceStatusHistory",
    "DeviceTelemetry",
    "EnrollmentToken",
    "EnrollmentAudit",
    "NotificationChannel",
    "NotificationDelivery",
    "NotificationRule",
    "ReportRun",
    "ReportSchedule",
    "Operator",
    "OperatorConnectPreference",
    "RemoteAction",
    "ReenrollmentRequest",
    "RevokedAgent",
    "RemoteSupportConnection",
    "DeviceTelemetryState",
    "MonitoringPolicy",
    "TelemetryRollup1h",
    "TelemetryRollup5m",
    "TelemetrySample",
    "TerminalSession",
    "TrustedDomain",
    "VaultCredential",
    "VaultCredentialAssignment",
    "VaultCredentialUsage",
]

from app.models.constraints import attach_checks  # noqa: E402

attach_checks()
