import json
import logging
import uuid
from typing import List, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.time import utcnow
from app.models.agent_command_batch import AgentCommandBatch
from app.models.device import Device, DeviceStatus
from app.models.operator import Operator
from app.models.remote_action import ActionStatus, RemoteAction
from app.repositories.agent_command_repository import AgentCommandRepository
from app.repositories.device_repository import DeviceRepository
from app.repositories.remote_action_repository import RemoteActionRepository
from app.schemas.agent_command import (
    BatchCreateResponse,
    BatchProgressResponse,
    BatchSummary,
    BulkCommandCreate,
    BulkCommandTarget,
    DeviceCommandStatus,
)
from app.services import version_service
from app.services.agent_package_service import AgentPackageService

logger = logging.getLogger(__name__)

# Agent fleet is Windows-only today — self_update always targets this platform.
SELF_UPDATE_PLATFORM = "windows-amd64"

# First agent version whose self_update swaps the standalone exe. Older agents
# save the payload as .msi and run msiexec, so they must receive an MSI.
# Version is the only reliable discriminator: 2.1.1 builds deployed before the
# SHA-reporting rebuild run the binary-swap flow but never report agent_sha256,
# and sending them an MSI makes them install the MSI bytes as techi-agent.exe.
BINARY_SELF_UPDATE_MIN_VERSION = (2, 1, 1)

# Maps remote_action status → agent command concept
_STATUS_MAP = {
    ActionStatus.QUEUED: "queued",
    ActionStatus.SENT: "delivered",
    ActionStatus.ACKNOWLEDGED: "delivered",
    ActionStatus.RUNNING: "executing",
    ActionStatus.COMPLETED: "completed",
    ActionStatus.FAILED: "failed",
    ActionStatus.EXPIRED: "timeout",
    ActionStatus.CANCELLED: "timeout",
}


class AgentCommandService:
    def __init__(self, db: Session):
        self.db = db
        self.batch_repo = AgentCommandRepository(db)
        self.action_repo = RemoteActionRepository(db)
        self.device_repo = DeviceRepository(db)

    def create_bulk(
        self,
        create_in: BulkCommandCreate,
        operator_id: Optional[int] = None,
        operator_username: Optional[str] = None,
    ) -> BatchCreateResponse:
        devices = self._resolve_devices(create_in)
        if not devices:
            raise ValueError("No active devices found for the specified target")

        batch_id = str(uuid.uuid4())
        self_update_payloads_by_device_id = {}
        if create_in.command_type == "self_update":
            default_payload, self_update_payloads_by_device_id = self._build_self_update_payloads(devices)
            payload_json = json.dumps(default_payload)
        else:
            payload_json = json.dumps(create_in.payload)

        timeout_seconds = self._effective_timeout_seconds(create_in)

        batch = AgentCommandBatch(
            id=batch_id,
            command_type=create_in.command_type,
            payload=payload_json,
            target=create_in.target.value,
            timeout_seconds=timeout_seconds,
            created_by=operator_id,
        )
        self.db.add(batch)
        self.db.flush()

        now = utcnow()
        for device in devices:
            action_payload_json = payload_json
            if create_in.command_type == "self_update":
                action_payload_json = json.dumps(self_update_payloads_by_device_id[device.id])
            action = RemoteAction(
                device_id=device.id,
                action_type=create_in.command_type,
                payload=action_payload_json,
                status=ActionStatus.QUEUED,
                created_at=now,
                queued_at=now,
                created_by=operator_username,
                execution_timeout_seconds=timeout_seconds,
                batch_id=batch_id,
            )
            self.db.add(action)
            # PostgreSQL stores status as an enum. SQLAlchemy's multi-row
            # insert path can bind that enum as VARCHAR for large batches,
            # which Postgres rejects. Flushing each action keeps the whole
            # transaction atomic while using the single-row insert path that
            # correctly casts the enum.
            self.db.flush()

        self.db.commit()
        self.db.refresh(batch)
        logger.info(
            "[command_batch] created %s batch=%s devices=%d by=%s",
            create_in.command_type,
            batch_id,
            len(devices),
            operator_username,
        )

        return BatchCreateResponse(
            batch_id=batch_id,
            device_count=len(devices),
            created_at=batch.created_at,
        )

    def get_batch_progress(self, batch_id: str) -> Optional[BatchProgressResponse]:
        batch = self.batch_repo.get_batch(batch_id)
        if batch is None:
            return None

        actions = self.batch_repo.get_batch_actions(batch_id)
        # Lazy-expire timed-out actions
        for action in actions:
            self.action_repo._expire_if_needed(action)

        counts = {"queued": 0, "delivered": 0, "executing": 0, "completed": 0, "failed": 0, "timeout": 0}
        device_statuses: List[DeviceCommandStatus] = []

        for action in actions:
            concept = _STATUS_MAP.get(action.status, "queued")
            counts[concept] = counts.get(concept, 0) + 1

            device = self.device_repo.get(action.device_id)
            device_statuses.append(DeviceCommandStatus(
                device_id=action.device_id,
                hostname=device.hostname if device else None,
                status=concept,
                output=action.output or action.result_message,
                error=action.error_message or action.stderr_output,
            ))

        total = len(actions)
        done = counts["completed"] + counts["failed"] + counts["timeout"]
        percent = int(done / total * 100) if total > 0 else 100
        finished = total == 0 or done == total

        return BatchProgressResponse(
            batch_id=batch_id,
            command_type=batch.command_type,
            total=total,
            queued=counts["queued"],
            delivered=counts["delivered"],
            executing=counts["executing"],
            completed=counts["completed"],
            failed=counts["failed"],
            timeout=counts["timeout"],
            percent=percent,
            devices=device_statuses,
            created_at=batch.created_at,
            finished=finished,
        )

    def get_history(self, limit: int = 20, skip: int = 0) -> List[BatchSummary]:
        batches = self.batch_repo.get_history(limit=limit, skip=skip)
        result: List[BatchSummary] = []

        operator_ids = {batch.created_by for batch in batches if batch.created_by is not None}
        operator_names = {}
        if operator_ids:
            operators = self.db.query(Operator).filter(Operator.id.in_(operator_ids)).all()
            operator_names = {op.id: (op.display_name or op.username) for op in operators}

        for batch in batches:
            actions = self.batch_repo.get_batch_actions(batch.id)
            for action in actions:
                self.action_repo._expire_if_needed(action)

            counts = {"completed": 0, "failed": 0, "timeout": 0}
            for action in actions:
                concept = _STATUS_MAP.get(action.status, "queued")
                if concept in counts:
                    counts[concept] += 1

            total = len(actions)
            done = sum(counts.values())

            result.append(BatchSummary(
                batch_id=batch.id,
                command_type=batch.command_type,
                target=batch.target,
                total=total,
                completed=counts["completed"],
                failed=counts["failed"],
                timeout=counts["timeout"],
                finished=total == 0 or done == total,
                created_at=batch.created_at,
                created_by_name=operator_names.get(batch.created_by),
            ))

        return result

    def cancel_batch(self, batch_id: str) -> dict:
        batch = self.batch_repo.get_batch(batch_id)
        if batch is None:
            raise ValueError("Batch not found")

        actions = self.batch_repo.get_batch_actions(batch_id)
        cancelled = 0
        for action in actions:
            if action.status == ActionStatus.QUEUED:
                self.action_repo.mark_cancelled(action)
                cancelled += 1

        logger.info("[command_batch] cancelled batch=%s (cancelled=%d)", batch_id, cancelled)
        return {"cancelled": cancelled}

    @staticmethod
    def _build_self_update_payloads(devices: List[Device]) -> tuple[dict, dict[int, dict]]:
        """Per-device self_update payloads: which binary each device installs.

        Windows keeps its existing behaviour exactly — the active
        windows-amd64 agent_binary, with the legacy MSI bridge for agents
        below 2.1.1. Linux resolves the active package for the device's OWN
        architecture and points at the public per-platform download endpoint.

        Linux was previously handed the Windows payload, which is why UI
        self_update could never work there: the agent was told to install an
        .exe, and its handler ignored the parameters anyway (fixed in agent
        2.1.23, 2026-08-05).
        """
        service = AgentPackageService()
        backend_url = settings.PUBLIC_BACKEND_URL.rstrip("/")

        windows_devices = [d for d in devices if (d.platform or "windows").strip().lower() == "windows"]
        linux_devices = [d for d in devices if (d.platform or "").strip().lower() == "linux"]
        unsupported = [d for d in devices if d not in windows_devices and d not in linux_devices]
        if unsupported:
            names = ", ".join(sorted(d.hostname or str(d.id) for d in unsupported[:5]))
            raise ValueError(f"self_update is not supported for these devices: {names}")

        payloads: dict[int, dict] = {}
        default_payload: dict | None = None

        if windows_devices:
            package = _active_self_update_package(service)
            binary_payload = {
                "download_url": f"{backend_url}{service.agent_binary_download_url()}",
                "version": package.version,
                "sha256": package.sha256,
            }
            default_payload = binary_payload

            legacy_devices = [d for d in windows_devices if _requires_legacy_msi_self_update(d)]
            msi_payload = None
            if legacy_devices:
                msi_package = service.latest_active(SELF_UPDATE_PLATFORM, file_type="agent_update_msi")
                if msi_package is None or msi_package.version != package.version:
                    hostnames = ", ".join(sorted(d.hostname or str(d.id) for d in legacy_devices[:5]))
                    extra = "" if len(legacy_devices) <= 5 else f" (+{len(legacy_devices) - 5} more)"
                    raise ValueError(
                        "Legacy agents (version < 2.1.1) require an active Agent Update "
                        f"Bridge MSI (file_type=agent_update_msi) for version {package.version} "
                        f"before UI self_update can run. Affected devices: {hostnames}{extra}. "
                        "Upload/activate the matching bridge MSI or update them once via GPO/NETLOGON."
                    )
                msi_payload = {
                    "download_url": f"{backend_url}{service.agent_update_msi_download_url()}",
                    "version": package.version,
                    # Old agents use this URL as an MSI. Verify completion against
                    # the installed agent exe hash instead of the MSI file hash.
                    "sha256": msi_package.sha256,
                    "target_sha256": package.sha256,
                    "package_type": "msi",
                }

            for device in windows_devices:
                use_msi = msi_payload is not None and _requires_legacy_msi_self_update(device)
                payloads[device.id] = dict(msi_payload if use_msi else binary_payload)

        for device in linux_devices:
            platform_key = version_service.package_platform("linux", device.architecture)
            if platform_key is None:
                raise ValueError(
                    f"{device.hostname or device.id}: unknown Linux architecture "
                    f"{device.architecture!r}; cannot choose an agent package"
                )
            package = service.latest_active(platform_key, file_type="agent_binary")
            if package is None:
                raise ValueError(
                    f"No active agent binary package for '{platform_key}'. "
                    f"Upload and activate one before running self_update on "
                    f"{device.hostname or device.id}."
                )
            payload = {
                "download_url": (
                    f"{backend_url}{settings.API_PREFIX}"
                    f"/agent-packages/platform/{platform_key}/download"
                ),
                "version": package.version,
                "sha256": package.sha256,
            }
            payloads[device.id] = payload
            if default_payload is None:
                default_payload = payload

        return default_payload or {}, payloads

    @staticmethod
    def _effective_timeout_seconds(create_in: BulkCommandCreate) -> int:
        if create_in.command_type == "self_update":
            return max(create_in.timeout_seconds, 900)
        if create_in.command_type == "set_remote_password":
            return max(create_in.timeout_seconds, 300)
        return create_in.timeout_seconds

    def _resolve_devices(self, create_in: BulkCommandCreate) -> List[Device]:
        query = self.db.query(Device).filter(
            (Device.is_archived.is_(False)) | (Device.is_archived.is_(None))
        )

        if create_in.target == BulkCommandTarget.ONLINE:
            query = query.filter(Device.status == DeviceStatus.ONLINE)
        elif create_in.target == BulkCommandTarget.CLIENT:
            if not create_in.client_id:
                raise ValueError("client_id required for target=client")
            query = query.filter(Device.client_id == create_in.client_id)
        elif create_in.target == BulkCommandTarget.GROUP:
            if not create_in.group_id:
                raise ValueError("group_id required for target=group")
            query = query.filter(Device.group_id == create_in.group_id)
        elif create_in.target == BulkCommandTarget.DEVICES:
            if not create_in.device_ids:
                raise ValueError("device_ids required for target=devices")
            query = query.filter(Device.id.in_(create_in.device_ids))
        elif create_in.target == BulkCommandTarget.OUTDATED_AGENTS:
            if create_in.command_type != "self_update":
                raise ValueError("target=outdated_agents is only supported for self_update")
            package = _active_self_update_package(AgentPackageService())
            query = query.filter(
                or_(
                    Device.agent_version.is_(None),
                    Device.agent_version != package.version,
                    Device.agent_sha256.is_(None),
                    Device.agent_sha256 != (package.sha256 or "").lower(),
                )
            )

        return query.all()


def _active_self_update_package(service: AgentPackageService):
    package = service.latest_active(SELF_UPDATE_PLATFORM, file_type="agent_binary")
    if package is None:
        raise ValueError(
            f"No active agent binary package for platform '{SELF_UPDATE_PLATFORM}'. "
            "Upload and activate a techi-agent.exe under Agent Packages -> Agent Binary."
        )
    return package


def _parse_agent_version(raw: Optional[str]) -> Optional[tuple]:
    text = (raw or "").strip().lstrip("vV")
    if not text:
        return None
    parts = []
    for piece in text.split("."):
        digits = ""
        for ch in piece:
            if not ch.isdigit():
                break
            digits += ch
        if not digits:
            return None
        parts.append(int(digits))
    return tuple(parts)


def _requires_legacy_msi_self_update(device: Device) -> bool:
    if (device.agent_sha256 or "").strip():
        return False
    version = _parse_agent_version(device.agent_version)
    if version is None:
        # Unknown/unparseable version — assume the oldest (msiexec) flow.
        return True
    return version < BINARY_SELF_UPDATE_MIN_VERSION
