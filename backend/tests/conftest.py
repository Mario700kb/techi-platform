"""Project-wide pytest fixtures for the backend test suite.

The Vault master key defaults to the repo-relative ``data/vault_master.key``
(``settings.VAULT_MASTER_KEY_FILE``). Any test that exercises the Credential
Vault — directly or transitively — would otherwise create that file under
``backend/data/`` and leave it behind as a repository artifact.

The ``_isolated_vault_master_key`` fixture below redirects the key to a
per-test temporary file for *every* test (mirroring the per-module fixtures
already used by the vault-touching tests), so:

* each test process/worker uses its own isolated key (``tmp_path`` is unique
  per test and per pytest-xdist worker — parallel tests never share a key file),
* pytest removes the temp directory automatically (no artifact remains),
* the production/default ``settings.VAULT_MASTER_KEY_FILE`` is untouched
  outside the test run.
"""

import pytest

from app.core import vault_cipher
from app.core.config import settings


@pytest.fixture(autouse=True)
def _isolated_vault_master_key(tmp_path, monkeypatch):
    monkeypatch.setattr(
        settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key")
    )
    vault_cipher.reset_master_key_cache_for_tests()
    yield
    vault_cipher.reset_master_key_cache_for_tests()
