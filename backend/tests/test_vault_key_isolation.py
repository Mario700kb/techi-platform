"""Regression: the test/preflight path must never create backend/data/vault_master.key.

The Vault master key defaults to the repo-relative ``data/vault_master.key``.
Before the isolation fixture (tests/conftest.py) any vault-touching test left
that file behind under ``backend/data/``. These tests prove the isolation holds.
"""

import tempfile
from pathlib import Path

from app.core import vault_cipher
from app.core.config import settings

# backend/data/vault_master.key — the repo artifact that must never be created
# by the test run.
_REPO_DEFAULT_KEY = (
    Path(__file__).resolve().parents[1] / "data" / "vault_master.key"
)


def test_active_vault_key_is_isolated_not_repo_default():
    """The autouse fixture must redirect the key OUT of the repo, into a temp dir."""
    active = Path(settings.VAULT_MASTER_KEY_FILE).resolve()
    assert (
        active != _REPO_DEFAULT_KEY
    ), "vault master key must not resolve to backend/data/vault_master.key during tests"
    tmp_root = Path(tempfile.gettempdir()).resolve()
    # pytest's tmp_path lives under the OS temp area (its basename contains
    # 'pytest'); either signal proves the key is temp-scoped, not in-repo.
    assert str(active).startswith(str(tmp_root)) or "pytest" in str(active), (
        f"expected a temp-scoped key path, got {active}"
    )


def test_vault_usage_does_not_create_repo_artifact(tmp_path, monkeypatch):
    """Exercising the vault creates the key ONLY at the isolated temp path."""
    key_path = tmp_path / "vault_master.key"
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(key_path))
    vault_cipher.reset_master_key_cache_for_tests()

    existed_before = _REPO_DEFAULT_KEY.exists()

    token, wrapped = vault_cipher.encrypt_secret("isolation-check")
    assert vault_cipher.decrypt_secret(token, wrapped) == "isolation-check"

    # The key was created at the isolated temp path...
    assert key_path.exists(), "master key should be created at the isolated temp path"
    # ...and this run did not create the repository artifact.
    assert _REPO_DEFAULT_KEY.exists() == existed_before, (
        "test run must not create backend/data/vault_master.key"
    )

    vault_cipher.reset_master_key_cache_for_tests()
