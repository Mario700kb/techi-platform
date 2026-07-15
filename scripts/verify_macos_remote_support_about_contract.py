#!/usr/bin/env python3

import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "remote-support-macos/client-overlay"
APPLIER = ROOT / "scripts/apply_macos_remote_support_about_overlay.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> int:
    helper = (OVERLAY / "about_version.dart").read_text(encoding="utf-8")
    tests = (OVERLAY / "about_version_test.dart").read_text(encoding="utf-8")
    combined = helper + tests
    require("PackageInfo.fromPlatform" in helper, "macOS bundle metadata lookup missing")
    require("packageInfo.version.trim()" in helper, "marketing version lookup missing")
    require("packageInfo.buildNumber.trim()" in helper, "internal build lookup missing")
    require("if (!macOS)" in helper, "Windows/native path guard missing")
    require("nativeVersionLoader" in helper, "build-time fallback missing")
    require("1.4.6" not in combined, "stale About version literal remains")
    require("1.4.8 (148.4)" in tests, "packaged About display regression missing")

    version = (ROOT / "remote-support-macos/VERSION").read_text().strip()
    build = (ROOT / "remote-support-macos/BUILD_VERSION").read_text().strip()
    require(version == "1.4.8", f"unexpected public version: {version}")
    require(build == "148.4", f"unexpected internal build: {build}")

    with tempfile.TemporaryDirectory(prefix="techi-about-contract.") as temp:
        source = Path(temp)
        page = source / "flutter/lib/desktop/pages/desktop_setting_page.dart"
        page.parent.mkdir(parents=True)
        (source / "flutter/test").mkdir(parents=True)
        (source / "flutter/pubspec.yaml").write_text("name: flutter_hbb\n")
        page.write_text(
            "import 'package:flutter_hbb/desktop/pages/desktop_home_page.dart';\n"
            "Future<void> build() async {\n"
            "      final version = await bind.mainGetVersion();\n"
            "      final buildDate = await bind.mainGetBuildDate();\n"
            "      final values = {\n"
            "        'version': version,\n"
            "      };\n"
            "}\n"
        )
        for _ in range(2):
            subprocess.run([sys.executable, APPLIER, source], check=True, capture_output=True)
        patched = page.read_text()
        require(patched.count("desktop/about_version.dart") == 1, "overlay is not idempotent")
        require("nativeVersionLoader: bind.mainGetVersion" in patched, "native fallback not wired")
        require("'version': aboutVersion.displayVersion" in patched, "About display not wired")

    print("macOS Remote Support About version contract: PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"macOS Remote Support About version contract failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
