import re
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.device import Device, DeviceType
from app.models.device_group import DeviceGroup
from app.platform_core import classification as clf
from app.repositories.client_repository import ClientRepository
from app.repositories.device_group_repository import DeviceGroupRepository
from app.repositories.device_repository import DeviceRepository
from app.schemas.client import ClientCreate
from app.schemas.device import DeviceUpdate
from app.schemas.device_group import DeviceGroupCreate
from app.services.trusted_domain_service import TrustedDomainService


@dataclass
class AssignmentSignal:
    hostname: Optional[str] = None
    domain: Optional[str] = None
    public_ip: Optional[str] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    os_caption: Optional[str] = None
    os_build: Optional[str] = None
    windows_product_type: Optional[int] = None
    platform: Optional[str] = None
    device_type: Optional[DeviceType] = None


@dataclass(frozen=True)
class AssignmentResolution:
    resolved_client_id: Optional[int]
    resolved_client_name: Optional[str]
    resolved_group: Optional[str]
    resolved_assignment_source: str
    resolved_device_category: str


class DeviceAssignmentService:
    MANUAL_SOURCE = "manual"
    LEGACY_MANUAL_SOURCE = "legacy_manual"
    TRUSTED_DOMAIN_SOURCE = "trusted_domain"
    ENROLLMENT_SOURCE = "enrollment_token"
    AUTO_OS_SOURCE = "auto_os"
    SYSTEM_AUTO_SOURCE = "system_auto"
    UNASSIGNED_SOURCE = "unassigned"
    INVALID_CLIENT_LABELS = {"", "workgroup", "localhost", "local"}
    INVALID_HOST_PREFIXES = ("desktop-", "laptop-", "win-", "pc-", "macbook-", "imac-")
    VALID_PRIVATE_SUFFIXES = {"local", "lan", "internal"}
    AUTHORITATIVE_SOURCES = {
        MANUAL_SOURCE,
        LEGACY_MANUAL_SOURCE,
        TRUSTED_DOMAIN_SOURCE,
        ENROLLMENT_SOURCE,
    }
    # Sources that lock client/group placement against ANY automatic re-assignment
    # (enrollment, heartbeat, trusted-domain reconcile). Trusted-domain is NOT here:
    # it is auto and is allowed to follow the domain. Single source of truth for the
    # "never undo a manual assignment" invariant — consumed by enrollment, heartbeat
    # and reconcile instead of each re-listing the set.
    MANUAL_LOCK_SOURCES = {
        MANUAL_SOURCE,
        LEGACY_MANUAL_SOURCE,
        ENROLLMENT_SOURCE,
    }

    @classmethod
    def is_manual_locked(cls, assignment_source: Optional[str]) -> bool:
        """True if this assignment must never be overwritten by automatic logic."""
        return (assignment_source or "").strip().lower() in cls.MANUAL_LOCK_SOURCES

    def __init__(self, db: Session):
        self.clients = ClientRepository(db)
        self.groups = DeviceGroupRepository(db)
        self.devices = DeviceRepository(db)
        self.trusted_domains = TrustedDomainService(db)

    def apply_enrollment_assignment(
        self,
        device: Device,
        *,
        client_id: Optional[int],
        group_id: Optional[int],
        signal: AssignmentSignal,
    ) -> Device:
        if self._has_authoritative_assignment(device):
            return device
        if client_id or group_id:
            # Generic, platform-neutral placement: a token may carry a Client with
            # no explicit Default Group. Resolve the standard group from the
            # agent-reported signal via the Unified Classification Engine
            # (_detect_group → Servers/Client PC), so ANY platform (Linux, MikroTik,
            # future) lands under the correct Client ▸ Group with no manual step.
            # Platform identity comes from the agent/adapter, never the token.
            if client_id and not group_id:
                self._ensure_standard_groups(client_id)
                group_id = self._get_or_create_group(client_id, self._detect_group(signal)).id
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
            if device.assignment_source == self.UNASSIGNED_SOURCE and not device.client_id and not device.group_id:
                return device
            return self.devices.update(
                device,
                DeviceUpdate(client_id=None, group_id=None, auto_assigned=False, assignment_source=self.UNASSIGNED_SOURCE),
            )

        client = self._get_client_for_domain(signal.domain, fallback_name=client_name)
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
        if self._has_authoritative_assignment(device):
            return False
        return device.client_id is None

    def _detect_client(self, signal: AssignmentSignal) -> tuple[Optional[str], str]:
        domain = self._clean(signal.domain)
        if self._is_domain_managed(domain):
            return self._normalize_domain_to_client_name(domain), self.TRUSTED_DOMAIN_SOURCE
        return None, self.UNASSIGNED_SOURCE

    def apply_trusted_domain_assignment(
        self,
        device: Device,
        *,
        domain: str,
        signal: AssignmentSignal,
    ) -> Device:
        """Assign a trusted-domain device directly from its domain name, bypassing token checks."""
        if not self._can_auto_assign(device):
            return device

        client_name = self._normalize_domain_to_client_name(domain) or TrustedDomainService.normalize_to_client_name(domain)
        client = self._get_client_for_domain(domain, fallback_name=client_name)
        group_name = TrustedDomainService.detect_group_name(
            signal.os_name,
            signal.platform,
            os_version=signal.os_version,
            os_caption=signal.os_caption,
            windows_product_type=signal.windows_product_type,
        )
        self._ensure_standard_groups(client.id)
        group = self._get_or_create_group(client.id, group_name)

        return self.devices.update(
            device,
            DeviceUpdate(
                client_id=client.id,
                group_id=group.id,
                auto_assigned=True,
                assignment_source=self.TRUSTED_DOMAIN_SOURCE,
            ),
        )

    def reconcile_trusted_domain_assignment(self, device: Device, *, signal: AssignmentSignal) -> Device:
        if not self._is_domain_managed(signal.domain):
            return device
        source = self._resolved_source(device)
        if self.is_manual_locked(source):
            return device

        client_name = self._normalize_domain_to_client_name(signal.domain) or TrustedDomainService.normalize_to_client_name(signal.domain or "")
        client = self._get_client_for_domain(signal.domain, fallback_name=client_name)
        self._ensure_standard_groups(client.id)
        group_name = TrustedDomainService.detect_group_name(
            signal.os_name,
            signal.platform,
            os_version=signal.os_version,
            os_caption=signal.os_caption,
            windows_product_type=signal.windows_product_type,
        )
        group = self._get_or_create_group(client.id, group_name)
        if (
            device.client_id == client.id
            and device.group_id == group.id
            and source == self.TRUSTED_DOMAIN_SOURCE
            and device.auto_assigned
        ):
            return device
        return self.devices.update(
            device,
            DeviceUpdate(
                client_id=client.id,
                group_id=group.id,
                auto_assigned=True,
                assignment_source=self.TRUSTED_DOMAIN_SOURCE,
            ),
        )

    def _ensure_standard_groups(self, client_id: int) -> None:
        """Guarantee that 'Servers' and 'Client PC' groups exist for a client."""
        for name in ("Servers", "Client PC"):
            self._get_or_create_group(client_id, name)

    def _detect_group(self, signal: AssignmentSignal) -> str:
        """Standard group name for a device being placed. Uses the Unified
        Classification Engine (server-ness = device_type SERVER / product-type /
        'windows server') so write-time placement and read-time counts agree."""
        category = clf.classify_category(clf.ClassificationInput(
            client_id=None, group_id=None, group_name=None,
            platform=signal.platform, device_type=signal.device_type,
            windows_product_type=signal.windows_product_type,
            os_name=signal.os_name, os_version=signal.os_version, os_caption=signal.os_caption,
        ))
        return "Servers" if category == clf.CATEGORY_SERVERS else "Client PC"

    def resolve_device_assignment(self, device: Device) -> AssignmentResolution:
        source = self._resolved_source(device)
        # Category via the one engine (device-KIND). Ownership ("unassigned") is
        # layered below on client/group presence.
        category = clf.classify_category(device)

        if device.client_id or device.group_id:
            return AssignmentResolution(
                resolved_client_id=device.client_id,
                resolved_client_name=device.client.name if device.client else None,
                resolved_group=device.group.name if device.group else None,
                resolved_assignment_source=source,
                resolved_device_category=category,
            )

        if self._is_domain_managed(device.domain):
            mapped_name = self.trusted_domains.mapped_client_name(device.domain)
            return AssignmentResolution(
                resolved_client_id=self.trusted_domains.mapped_client_id(device.domain),
                resolved_client_name=mapped_name or self._normalize_domain_to_client_name(device.domain),
                resolved_group="Servers" if category == "servers" else "Client PC",
                resolved_assignment_source=self.TRUSTED_DOMAIN_SOURCE,
                resolved_device_category=category,
            )

        return AssignmentResolution(
            resolved_client_id=None,
            resolved_client_name=None,
            resolved_group=None,
            resolved_assignment_source="unassigned",
            resolved_device_category="unassigned",
        )

    def apply_resolution(self, device: Device) -> Device:
        resolution = self.resolve_device_assignment(device)
        setattr(device, "resolved_client_id", resolution.resolved_client_id)
        setattr(device, "resolved_client_name", resolution.resolved_client_name)
        setattr(device, "resolved_group", resolution.resolved_group)
        setattr(device, "resolved_assignment_source", resolution.resolved_assignment_source)
        setattr(device, "resolved_device_category", resolution.resolved_device_category)
        return device

    def apply_resolution_many(self, devices: list[Device]) -> list[Device]:
        return [self.apply_resolution(device) for device in devices]

    def _has_authoritative_assignment(self, device: Device) -> bool:
        return self._resolved_source(device) in self.AUTHORITATIVE_SOURCES and (device.client_id is not None or device.group_id is not None)

    def _resolved_source(self, device: Device) -> str:
        source = (device.assignment_source or "").strip().lower()
        if not source and (device.client_id is not None or device.group_id is not None):
            return self.LEGACY_MANUAL_SOURCE
        if source in {"domain_match", "hostname_match"}:
            return self.TRUSTED_DOMAIN_SOURCE
        if source == "system_auto_unassigned":
            return "unassigned"
        return source or "unassigned"

    @classmethod
    def _is_domain_managed(cls, domain: Optional[str]) -> bool:
        normalized = cls._clean_static(domain).strip(".").lower()
        return bool(normalized) and normalized != "workgroup"

    @classmethod
    def _normalize_domain_to_client_name(cls, domain: Optional[str]) -> Optional[str]:
        if not cls._is_domain_managed(domain):
            return None
        label = cls._clean_static(domain).strip(".").split(".", 1)[0]
        return cls._humanize(label)


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

    def _get_client_for_domain(self, domain: Optional[str], *, fallback_name: str) -> Client:
        mapped_client_id = self.trusted_domains.mapped_client_id(domain)
        if mapped_client_id is not None:
            mapped = self.clients.get(mapped_client_id)
            if mapped:
                return mapped
        mapped_client_name = self.trusted_domains.mapped_client_name(domain)
        if mapped_client_name:
            return self._get_or_create_client(mapped_client_name)
        return self._get_or_create_client(fallback_name)

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
