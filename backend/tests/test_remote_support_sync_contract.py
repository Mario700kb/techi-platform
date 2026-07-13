from types import SimpleNamespace

import pytest

from app.api.v1.endpoints.agent import _apply_remote_support_sync_contract


class FakeDB:
    def add(self, device):
        self.device = device

    def commit(self):
        pass

    def refresh(self, device):
        pass


def _device(**overrides):
    values = dict(
        remote_support_apply_status="applied",
        remote_support_active_generation=4,
        remote_support_applied_generation=4,
        rustdesk_sync_state="unknown",
        rustdesk_sync_message=None,
        rustdesk_synced_at=None,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.mark.parametrize(
    ("credential_status", "reported", "expected"),
    [
        ("pending", "applied", "pending"),
        ("failed", "applied", "failed"),
        ("unsupported_legacy", "applied", "unsupported_legacy"),
        ("applied", "conflicted", "conflicted"),
        ("applied", "applied", "applied"),
    ],
)
def test_sync_state_requires_backend_credential_and_agent_semantics(
    credential_status, reported, expected
):
    device = _device(remote_support_apply_status=credential_status)
    _apply_remote_support_sync_contract(FakeDB(), device, reported)
    assert device.rustdesk_sync_state == expected


def test_sync_state_rejects_generation_mismatch():
    device = _device(remote_support_active_generation=5, remote_support_applied_generation=4)
    _apply_remote_support_sync_contract(FakeDB(), device, "applied")
    assert device.rustdesk_sync_state == "conflicted"
