#!/usr/bin/env python3
"""Fail closed when generated bootstrap flags exceed the built Agent contract."""

import argparse
import ast
import json
import re
import runpy
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, Set


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_MODULE = ROOT / "backend/app/services/bootstrap_config_contract.py"
ARGUMENT_BUILDER_MODULE = ROOT / "backend/app/core/bootstrap_arguments.py"
BOOTSTRAP_SOURCE = ROOT / "backend/app/services/enrollment_bootstrap_service.py"
AGENT_VERSION_FILE = ROOT / "agent/VERSION"
VERSIONED_CONTRACT_FILES = {
    "agent/bootstrap_contract.go",
    "agent/bootstrap_windows.go",
    "backend/app/services/bootstrap_config_contract.py",
}


class ContractError(RuntimeError):
    pass


def _python_constants(path: Path) -> Dict[str, Any]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    values: Dict[str, Any] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name):
            values[target.id] = ast.literal_eval(node.value)
    return values


def _bootstrap_invocations() -> tuple[str, str]:
    namespace = runpy.run_path(str(ARGUMENT_BUILDER_MODULE))
    builder = namespace["build_windows_bootstrap_config_invocation"]
    empty = builder(
        remote_support_auto_repair_mode="disabled",
        remote_support_auto_repair_device_ids="",
    )
    populated = builder(
        remote_support_auto_repair_mode="canary",
        remote_support_auto_repair_device_ids="11,22",
    )
    if "-remote-support-auto-repair-device-ids" in empty:
        raise ContractError("generated empty allowlist invocation emits a bare optional flag")
    if '-remote-support-auto-repair-device-ids "11,22"' not in populated:
        raise ContractError("generated allowlist is not one safely quoted argument")
    return empty, populated


def _invoked_bootstrap_flags() -> Set[str]:
    return {
        flag
        for invocation in _bootstrap_invocations()
        for flag in re.findall(r"(?<![A-Za-z0-9])-[-a-z0-9]+", invocation)
    }


def _require_runtime_guard(source: str) -> None:
    guard = '"if (-not (Test-AgentBootstrapConfigContract $AgentExe)) {"'
    invocation = "\n            bootstrap_config_invocation,"
    guard_index = source.find(guard)
    invocation_index = source.find(invocation)
    if guard_index < 0 or invocation_index < 0 or guard_index > invocation_index:
        raise ContractError("bootstrap-config invocation is not protected by its runtime contract guard")


def _git_lines(*args: str) -> Iterable[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return (line.strip() for line in result.stdout.splitlines() if line.strip())


def _verify_version_bump(compare_ref: str, current_version: str) -> None:
    changed = set(_git_lines("diff", "--name-only", compare_ref, "HEAD"))
    if not changed.intersection(VERSIONED_CONTRACT_FILES):
        return
    previous = subprocess.run(
        ["git", "show", f"{compare_ref}:agent/VERSION"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    if previous == current_version:
        raise ContractError(
            "bootstrap-config contract changed without incrementing agent/VERSION"
        )


def verify_contract(contract: Dict[str, Any], *, compare_ref: str = "") -> None:
    constants = _python_constants(CONTRACT_MODULE)
    expected_contract = str(constants["BOOTSTRAP_CONFIG_CONTRACT_VERSION"])
    required = set(constants["BOOTSTRAP_CONFIG_REQUIRED_FLAGS"])
    current_version = AGENT_VERSION_FILE.read_text(encoding="ascii").strip()
    source = BOOTSTRAP_SOURCE.read_text(encoding="utf-8")
    invoked = _invoked_bootstrap_flags()
    supported = set(contract.get("supported_flags") or [])

    if str(contract.get("agent_version")) != current_version:
        raise ContractError(
            f"binary agent_version={contract.get('agent_version')} does not match agent/VERSION={current_version}"
        )
    if str(contract.get("contract_version")) != expected_contract:
        raise ContractError(
            "binary and backend bootstrap-config contract versions do not match"
        )
    if invoked != required:
        raise ContractError(
            f"generated invocation flags={sorted(invoked)} do not match backend contract={sorted(required)}"
        )
    unsupported = invoked - supported
    if unsupported:
        raise ContractError(
            f"generated bootstrap references unsupported binary flags: {sorted(unsupported)}"
        )
    _require_runtime_guard(source)
    if compare_ref:
        _verify_version_bump(compare_ref, current_version)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract-json", type=Path, required=True)
    parser.add_argument("--compare-ref", default="")
    args = parser.parse_args()
    try:
        contract = json.loads(args.contract_json.read_text(encoding="utf-8-sig"))
        verify_contract(contract, compare_ref=args.compare_ref)
    except (ContractError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"bootstrap contract verification failed: {exc}")
        return 1
    print(
        "bootstrap contract verified: "
        f"agent_version={contract['agent_version']} "
        f"contract_version={contract['contract_version']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
