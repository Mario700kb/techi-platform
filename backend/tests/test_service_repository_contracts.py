"""Deployment Contract Verification — service ↔ repository interface guards.

Two layers, both designed to fail the build BEFORE deploy if a service and its
repository drift apart (the Device Catalog 500 regression: a service forwarded a
kwarg the repository did not accept):

1. Signature contract (DB-free): for delegating service→repository pairs, the
   kwargs the service forwards MUST be a subset of what the repository accepts.
2. End-to-end contract (in-memory DB): each public service is instantiated and a
   representative read method is called through to its repository/SQL, so any
   signature mismatch raises here rather than in production.
"""

import inspect

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def _params(func) -> set:
    return {
        name
        for name, p in inspect.signature(func).parameters.items()
        if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY) and name != "self"
    }


# --------------------------------------------------------------------------- #
# 1. Signature contracts — the precise guard for the regression class.         #
#    (service_method, repository_method, params ignored on the service side)   #
# --------------------------------------------------------------------------- #

class TestSignatureContracts:
    def test_device_service_get_devices_forwards_subset(self):
        from app.services.device_service import DeviceService
        from app.repositories.device_repository import DeviceRepository

        forwarded = _params(DeviceService.get_devices) - {"skip", "limit", "agent_update_state"}
        accepted = _params(DeviceRepository.get_multi)
        missing = forwarded - accepted
        assert not missing, f"DeviceService.get_devices forwards params the repo lacks: {missing}"

    def test_device_service_count_forwards_subset(self):
        from app.services.device_service import DeviceService
        from app.repositories.device_repository import DeviceRepository

        forwarded = _params(DeviceService.get_devices_count) - {"agent_update_state"}
        accepted = _params(DeviceRepository.count)
        missing = forwarded - accepted
        assert not missing, f"DeviceService.get_devices_count forwards params the repo lacks: {missing}"


# --------------------------------------------------------------------------- #
# 2. End-to-end contracts — each public service through to its repository.      #
# --------------------------------------------------------------------------- #

class TestEndToEndContracts:
    def test_device_service(self):
        from app.services.device_service import DeviceService
        svc = DeviceService(_db())
        assert svc.get_devices() == []
        assert svc.get_devices_count() == 0
        # every expansion filter must round-trip
        assert svc.get_devices_count(platform="windows", category="network") == 0

    def test_device_overview_service(self):
        from app.services.device_overview_service import DeviceOverviewService, _overview_cache
        # The service memoizes by scope in a module-level cache; clear it so this
        # runs against our fresh DB regardless of test order. The contract here is
        # that the service → repository → SQL path executes without a signature
        # mismatch, not a specific count.
        _overview_cache.clear()
        overview = DeviceOverviewService(_db()).get_overview()
        assert overview is not None and overview.stats is not None

    def test_vault_service(self):
        from app.services.vault_service import VaultService
        assert VaultService(_db()).list() == []

    def test_enrollment_token_service(self):
        from app.services.enrollment_token_service import EnrollmentTokenService
        assert EnrollmentTokenService(_db()).list() == []

    def test_terminal_service(self):
        from app.services.terminal_service import TerminalService
        svc = TerminalService(_db())
        session, op_ticket, _ = svc.create_session(device_id=1, operator_id=1, operator_username="m")
        assert svc.get(session.id) is not None

    def test_connect_service(self):
        # ConnectService = the platform_core.connect metadata function.
        from app.platform_core.connect import methods_for
        assert [m.id for m in methods_for("windows", None)] == ["remote_support"]

    def test_agent_package_service(self):
        from app.services.agent_package_service import AgentPackageService
        # Manifest-backed; an empty/absent store must yield [] not an error.
        assert isinstance(AgentPackageService().list_packages(), list)

    def test_remote_action_service(self):
        from app.services.remote_action_service import RemoteActionService
        assert RemoteActionService(_db()).get_recent(device_id=1) == []

    def test_notification_service(self):
        from app.repositories.notification_repository import (
            NotificationChannelRepository,
            NotificationDeliveryRepository,
            NotificationRuleRepository,
        )
        db = _db()
        assert NotificationChannelRepository(db).list() == []
        assert NotificationRuleRepository(db).list() == []
        items, total = NotificationDeliveryRepository(db).list_history()
        assert items == [] and total == 0
