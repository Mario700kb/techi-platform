import re
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.device import Device, DeviceType
from app.models.device_group import DeviceGroup
from app.repositories.client_repository import ClientRepository
from app.repositories.device_group_repository import DeviceGroupRepository
from app.repositories.device_repository import DeviceRepository
from app.schemas.client import ClientCreate
from app.schemas.device import DeviceUpdate
from app.schemas.device_group import DeviceGroupCreate


@dataclass
class AssignmentSignal:
    hostname: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    os_name: Optional[str] = None
    platform: Optional[str] = None
    device_type: Optional[DeviceType] = None


class DeviceAssignmentService:
    MANUAL_SOURCE = "manual"
    ENROLLMENT_SOURCE = "enrollment_token"
    UNASSIGNED_SOURCE = "system_auto_unassigned"
    INVALID_CLIENT_LABELS = {"", "workgroup", "localhost", "local"}
    INVALID_HOST_PREFIXES = ("desktop-", "laptop-", "win-", "pc-", "macbook-", "imac-")
    VALID_PRIVATE_SUFFIXES = {"local", "lan", "internal"}

    def __init__(self, db: Session):
        self.clients = ClientRepository(db)
        self.groups = DeviceGroupRepository(db)
        self.devices = DeviceRepository(db)

    def apply_enrollment_assignment(
        self,
        device: Device,
        *,
        client_id: Optional[int],
        group_id: Optional[int],
        signal: AssignmentSignal,
    ) -> Device:
        if client_id or group_id:
            return self.devices.update(
                device,
                DeviceUpdate(
                    client_id=client_id,
                    group_id=group_id,
                    auto_assigned=False,
                    assignment_source=self.ENROLLMENT_SOURCE,
                ),
            )
        return self.apply_auto_assignment(device, signal=signal)

    def apply_auto_assignment(self, device: Device, *, signal: AssignmentSignal) -> Device:
        if not self._can_auto_assign(device):
            return device

        client_name, source = self._detect_client(signal)
        if not client_name:
            if device.assignment_source == self.UNASSIGNED_SOURCE:
                return device
            return self.devices.update(
                device,
                DeviceUpdate(auto_assigned=False, assignment_source=self.UNASSIGNED_SOURCE),
            )

        client = self._get_or_create_client(client_name)
        group = self._get_or_create_group(client.id, self._detect_group(signal))
        return self.devices.update(
            device,
            DeviceUpdate(
                client_id=client.id,
                group_id=group.id,
                auto_assigned=True,
                assignment_source=source,
            ),
        )

    def _can_auto_assign(self, device: Device) -> bool:
        if device.assignment_source in {self.MANUAL_SOURCE, self.ENROLLMENT_SOURCE}:
            return False
        return device.client_id is None

    def _detect_client(self, signal: AssignmentSignal) -> tuple[Optional[str], str]:
        domain = self._clean(signal.domain)
        hostname = self._clean(signal.hostname)
        if self._is_valid_org_domain(domain, hostname):
            return self._humanize(domain.split(".")[0]), "domain_match"

        if self._is_valid_org_domain(hostname, hostname):
            labels = hostname.split(".")
            if len(labels) >= 3:
                return self._humanize(labels[-2]), "hostname_match"
            return self._humanize(labels[0]), "hostname_match"

        return None, self.UNASSIGNED_SOURCE

    def apply_trusted_domain_assignment(
        self,
        device: Device,
        *,
        domain: str,
        signal: AssignmentSignal,
    ) -> Device:
        """Assign a trusted-domain device directly from its domain name, bypassing token checks."""
        from app.services.trusted_domain_service import TrustedDomainService

        if not self._can_auto_assign(device):
            return device

        client_name = TrustedDomainService.normalize_to_client_name(domain)
        client = self._get_or_create_client(client_name)
        group_name = TrustedDomainService.detect_group_name(signal.os_name, signal.platform)
        self._ensure_standard_groups(client.id)
        group = self._get_or_create_group(client.id, group_name)

        return self.devices.update(
            device,
            DeviceUpdate(
                client_id=client.id,
                group_id=group.id,
                auto_assigned=True,
                assignment_source="trusted_domain",
            ),
        )

    def _ensure_standard_groups(self, client_id: int) -> None:
        """Guarantee that 'Servers' and 'Client PC' groups exist for a client."""
        for name in ("Servers", "Client PC"):
            self._get_or_create_group(client_id, name)

    def _detect_group(self, signal: AssignmentSignal) -> str:
        platform = self._clean(signal.platform).lower()
        os_name = self._clean(signal.os_name).lower()
        if "darwin" in platform or "mac" in platform or "mac" in os_name:
            return "Mac Devices"
        if "linux" in platform or "linux" in os_name:
            return "Linux Devices"
        if signal.device_type == DeviceType.SERVER or "server" in os_name:
            return "Servers"
        if any(value in os_name for value in ("router", "switch", "firewall", "network")):
            return "Network Devices"
        return "Client PC"

    def _get_or_create_client(self, name: str) -> Client:
        existing = self.clients.get_by_name_normalized(name)
        if existing:
            return existing
        slug = self._slugify(name)
        suffix = 2
        base_slug = slug
        while self.clients.get_by_slug(slug):
            slug = f"{base_slug}-{suffix}"
            suffix += 1
        return self.clients.create(ClientCreate(name=name, slug=slug, is_active=True), slug=slug)

    def _get_or_create_group(self, client_id: int, name: str) -> DeviceGroup:
        existing = self.groups.get_by_client_and_name(client_id, name)
        if existing:
            return existing
        return self.groups.create(DeviceGroupCreate(client_id=client_id, name=name))

    @classmethod
    def is_likely_fake_auto_client_name(cls, name: str) -> bool:
        normalized = cls._clean_static(name).lower()
        if normalized in cls.INVALID_CLIENT_LABELS:
            return True
        return normalized.startswith(cls.INVALID_HOST_PREFIXES)

    @classmethod
    def _is_valid_org_domain(cls, domain: str, hostname: str) -> bool:
        normalized = cls._clean_static(domain).lower().strip(".")
        normalized_hostname = cls._clean_static(hostname).lower().strip(".")
        if normalized in cls.INVALID_CLIENT_LABELS:
            return False
        if normalized == normalized_hostname:
            return False
        if normalized.startswith(cls.INVALID_HOST_PREFIXES):
            return False
        if "." not in normalized:
            return False

        labels = [label for label in normalized.split(".") if label]
        if len(labels) < 2:
            return False
        if any(label in cls.INVALID_CLIENT_LABELS for label in labels[:-1]):
            return False
        if any(label.startswith(cls.INVALID_HOST_PREFIXES) for label in labels):
            return False
        if len(labels[0]) < 2:
            return False

        suffix = labels[-1]
        return suffix in cls.VALID_PRIVATE_SUFFIXES or (len(labels) >= 3 and len(suffix) >= 2)

    @staticmethod
    def _clean(value: Optional[str]) -> str:
        return value.strip() if value else ""

    @staticmethod
    def _clean_static(value: str) -> str:
        return value.strip() if value else ""

    @staticmethod
    def _humanize(value: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9]+", " ", value).strip()
        return cleaned.title() if cleaned else "Default Client"

    @staticmethod
    def _slugify(value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
        return slug or "client"
