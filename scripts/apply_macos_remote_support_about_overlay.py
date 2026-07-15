#!/usr/bin/env python3

import argparse
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "remote-support-macos/client-overlay"
IMPORT_LINE = "import 'package:flutter_hbb/desktop/about_version.dart';"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def apply(source_root: Path) -> None:
    flutter = source_root / "flutter"
    page = flutter / "lib/desktop/pages/desktop_setting_page.dart"
    helper = flutter / "lib/desktop/about_version.dart"
    test = flutter / "test/about_version_test.dart"
    if not page.is_file() or not (flutter / "pubspec.yaml").is_file():
        raise RuntimeError(f"not a compatible Flutter client source: {source_root}")

    text = page.read_text(encoding="utf-8-sig")
    if IMPORT_LINE not in text:
        text = replace_once(
            text,
            "import 'package:flutter_hbb/desktop/pages/desktop_home_page.dart';",
            f"{IMPORT_LINE}\n"
            "import 'package:flutter_hbb/desktop/pages/desktop_home_page.dart';",
            "desktop About import anchor",
        )
        text = replace_once(
            text,
            "      final version = await bind.mainGetVersion();\n"
            "      final buildDate = await bind.mainGetBuildDate();",
            "      final aboutVersion = await loadAboutVersionData(\n"
            "        macOS: isMacOS,\n"
            "        nativeVersionLoader: bind.mainGetVersion,\n"
            "      );\n"
            "      debugPrint('About version source: ${aboutVersion.source}');\n"
            "      final buildDate = await bind.mainGetBuildDate();",
            "desktop About version loader",
        )
        text = replace_once(
            text,
            "        'version': version,",
            "        'version': aboutVersion.displayVersion,",
            "desktop About version value",
        )
    elif (
        "nativeVersionLoader: bind.mainGetVersion" not in text
        or "'version': aboutVersion.displayVersion" not in text
    ):
        raise RuntimeError("desktop About overlay is only partially applied")

    page.write_text(text, encoding="utf-8")
    helper.parent.mkdir(parents=True, exist_ok=True)
    test.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OVERLAY / "about_version.dart", helper)
    shutil.copyfile(OVERLAY / "about_version_test.dart", test)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_root", type=Path)
    args = parser.parse_args()
    apply(args.source_root.resolve())
    print("macOS About bundle-metadata overlay: APPLIED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
