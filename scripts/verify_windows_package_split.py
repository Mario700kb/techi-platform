#!/usr/bin/env python3
"""Static guard for the Windows package split.

The build artifacts are verified more deeply on Windows in CI. This guard keeps
the source definitions honest on any platform: Agent MSI cannot reference the
Remote Support payload, and Remote Support installers cannot reference Agent.
"""
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENT_WXS = ROOT / "agent" / "installer" / "installer.wxs"
REMOTE_WXS = ROOT / "agent" / "installer" / "remote-support.wxs"
REMOTE_BUNDLE_WXS = ROOT / "agent" / "installer" / "remote-support-bundle.wxs"


def fail(message: str) -> None:
    raise SystemExit(f"package split verification failed: {message}")


def require_absent(path: Path, needles: list[str]) -> None:
    text = strip_xml_comments(path.read_text(encoding="utf-8"))
    lowered = text.lower()
    for needle in needles:
        if needle.lower() in lowered:
            fail(f"{path.relative_to(ROOT)} contains forbidden reference {needle!r}")


def require_present(path: Path, needles: list[str]) -> None:
    text = strip_xml_comments(path.read_text(encoding="utf-8"))
    lowered = text.lower()
    for needle in needles:
        if needle.lower() not in lowered:
            fail(f"{path.relative_to(ROOT)} is missing expected reference {needle!r}")


def strip_xml_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)


def main() -> None:
    require_present(AGENT_WXS, ["TECHI Agent", "techi-agent.exe", "TechiAgent"])
    require_absent(
        AGENT_WXS,
        [
            "TECHI-Remote-Support",
            "TECHI Remote Support.exe",
            "rustdesk.exe",
            "techi-remote-support-bridge.exe",
            "techiremotesupport",
        ],
    )

    require_present(
        REMOTE_WXS,
        [
            "TECHI Remote Support",
            "TECHI-Remote-Support",
            "TECHI Remote Support.exe",
            "techi-remote-support-bridge.exe",
            "techiremotesupport",
        ],
    )
    require_absent(REMOTE_WXS, ["techi-agent.exe", "TechiAgent"])

    require_present(REMOTE_BUNDLE_WXS, ["TECHI Remote Support", "MsiPackage"])
    require_absent(REMOTE_BUNDLE_WXS, ["techi-agent.exe", "TechiAgent"])

    print("package split verification passed")


if __name__ == "__main__":
    main()
