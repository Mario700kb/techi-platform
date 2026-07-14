import importlib.util
from pathlib import Path

import pytest

from app.services.bootstrap_config_contract import (
    BOOTSTRAP_CONFIG_CONTRACT_VERSION,
    BOOTSTRAP_CONFIG_REQUIRED_FLAGS,
)


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "verify_bootstrap_config_contract",
    ROOT / "scripts/verify_bootstrap_config_contract.py",
)
VERIFIER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VERIFIER)


def _contract():
    return {
        "agent_version": (ROOT / "agent/VERSION").read_text(encoding="ascii").strip(),
        "contract_version": BOOTSTRAP_CONFIG_CONTRACT_VERSION,
        "supported_flags": list(BOOTSTRAP_CONFIG_REQUIRED_FLAGS),
    }


def test_generated_bootstrap_matches_binary_contract():
    VERIFIER.verify_contract(_contract())


def test_publishing_fails_for_unsupported_bootstrap_flag():
    contract = _contract()
    contract["supported_flags"].remove("-remote-support-auto-repair-mode")
    with pytest.raises(VERIFIER.ContractError, match="unsupported binary flags"):
        VERIFIER.verify_contract(contract)
