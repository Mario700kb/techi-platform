from types import SimpleNamespace
from unittest.mock import MagicMock

from app.models.device import DeviceType
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService


def test_trusted_domain_assignment_uses_mapped_client_id():
    mapped_client = SimpleNamespace(id=99, name="Real Client")
    group = SimpleNamespace(id=7, client_id=99, name="Client PC")
    device = SimpleNamespace(client_id=None, group_id=None, assignment_source="unassigned")

    svc = DeviceAssignmentService.__new__(DeviceAssignmentService)
    svc.trusted_domains = MagicMock()
    svc.trusted_domains.mapped_client_id.return_value = 99
    svc.trusted_domains.mapped_client_name.return_value = "Real Client"
    svc.clients = MagicMock()
    svc.clients.get.return_value = mapped_client
    svc.groups = MagicMock()
    svc.devices = MagicMock()
    svc._get_or_create_group = MagicMock(return_value=group)
    svc._ensure_standard_groups = MagicMock()

    result = svc.apply_trusted_domain_assignment(
        device,
        domain="x.local",
        signal=AssignmentSignal(domain="x.local", device_type=DeviceType.CLIENT),
    )

    svc.clients.get.assert_called_once_with(99)
    svc._get_or_create_group.assert_called_once_with(99, "Client PC")
    svc.devices.update.assert_called_once()
    update_payload = svc.devices.update.call_args.args[1]
    assert update_payload.client_id == 99
    assert update_payload.group_id == 7
    assert update_payload.assignment_source == DeviceAssignmentService.TRUSTED_DOMAIN_SOURCE
    assert result == svc.devices.update.return_value
