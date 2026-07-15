#!/usr/bin/env python3

import argparse
import os
import plistlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

APP_NAME = "TECHI Remote Support.app"
BUNDLE_ID = "al.techi.remote-support"
ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / "remote-support-macos/VERSION").read_text().strip()
BUILD_VERSION = (ROOT / "remote-support-macos/BUILD_VERSION").read_text().strip()
ABOUT_VERSION_MARKER = b"bundle-metadata:CFBundleShortVersionString+CFBundleVersion"
SECURE_CONNECT_MARKER = b"techi-secure-connect-stdin-v1"
LSREGISTER = Path(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
    "LaunchServices.framework/Support/lsregister"
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def run(*args, check: bool = True, text: bool = True):
    return subprocess.run(
        [os.fspath(arg) for arg in args],
        check=check,
        text=text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def plist(app: Path) -> dict:
    with (app / "Contents/Info.plist").open("rb") as handle:
        return plistlib.load(handle)


def validate_app(app: Path) -> None:
    if not app.is_dir() or (app / APP_NAME).exists():
        fail("application bundle is missing or nested")
    metadata = plist(app)
    expected = {
        "CFBundleDisplayName": "TECHI Remote Support",
        "CFBundleName": "TECHI Remote Support",
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": BUILD_VERSION,
        "CFBundleExecutable": "TECHI Remote Support",
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            fail(f"unexpected {key}: {metadata.get(key)!r}")
    schemes = {
        scheme
        for entry in metadata.get("CFBundleURLTypes", [])
        for scheme in entry.get("CFBundleURLSchemes", [])
    }
    if schemes != {"techiremotesupport"}:
        fail(f"unexpected URL schemes: {sorted(schemes)}")

    executables = [
        app / "Contents/MacOS/TECHI Remote Support",
        app / "Contents/MacOS/TECHI Remote Support Client",
        app / "Contents/Helpers/techi-remote-support-bridge",
    ]
    for executable in executables:
        if not executable.is_file() or not os.access(executable, os.X_OK):
            fail(f"missing executable: {executable.relative_to(app)}")
        if "arm64" not in run("/usr/bin/lipo", "-archs", executable).stdout.split():
            fail(f"non-arm64 executable: {executable.relative_to(app)}")

    flutter_aot = app / "Contents/Frameworks/App.framework/Versions/A/App"
    if not any(
        candidate.is_file() and ABOUT_VERSION_MARKER in candidate.read_bytes()
        for candidate in (flutter_aot, executables[1])
    ):
        fail("Flutter About UI does not contain the bundle-metadata version contract")
    if not any(
        path.is_file() and not path.is_symlink() and SECURE_CONNECT_MARKER in path.read_bytes()
        for path in (app / "Contents").rglob("*")
    ):
        fail("packaged client does not contain the secure stdin credential contract")
    contract = subprocess.run(
        [os.fspath(executables[1]), "--techi-connect-self-test"],
        input="synthetic-contract-secret",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )
    if contract.returncode != 0 or contract.stdout.strip() != "TECHI_CONNECT_ACCEPTED_V1":
        fail("packaged client did not consume the secure stdin credential contract")
    if "synthetic-contract-secret" in contract.stdout or "synthetic-contract-secret" in contract.stderr:
        fail("packaged client exposed the stdin credential")

    for path in app.rglob("*"):
        if path.is_symlink() and not path.exists():
            fail(f"broken symlink: {path.relative_to(app)}")
        if not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) & 0o022:
            fail(f"group/world-writable bundle path: {path.relative_to(app)}")
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as handle:
                if re.search(rb"/Users/[^/\x00]+/", handle.read()):
                    fail(f"developer-local path embedded in bundle: {path.relative_to(app)}")

    run("/usr/bin/codesign", "--verify", "--deep", "--strict", app)
    run(executables[0], "--validate-install")


def make_old_app(path: Path, swift_source: Path) -> None:
    executable = path / "Contents/MacOS/OldRemoteSupport"
    executable.parent.mkdir(parents=True)
    (path / "Contents/old-install-marker").write_text("old\n", encoding="ascii")
    with (path / "Contents/Info.plist").open("wb") as handle:
        plistlib.dump(
            {
                "CFBundleDisplayName": "TECHI Remote Support",
                "CFBundleName": "TECHI Remote Support",
                "CFBundleIdentifier": BUNDLE_ID,
                "CFBundleShortVersionString": "1.4.7",
                "CFBundleVersion": "147.9",
                "CFBundleExecutable": executable.name,
                "LSMinimumSystemVersion": "12.3",
                "CFBundlePackageType": "APPL",
            },
            handle,
        )
    run(
        "/usr/bin/swiftc",
        "-O",
        "-framework",
        "AppKit",
        "-target",
        "arm64-apple-macos12.3",
        swift_source,
        "-o",
        executable,
    )
    run("/usr/bin/codesign", "--force", "--deep", "--sign", "-", path)


def wait_for_running(process_control: Path, app: Path) -> None:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        result = run(process_control, "verify-stopped", app, check=False)
        if result.returncode == 11:
            return
        time.sleep(0.2)
    fail("old test application did not start")


def exercise_pkg_scripts(component: Path, new_app: Path, work: Path) -> None:
    scripts = component / "Scripts"
    process_control = scripts / "package-process-control"
    preinstall = scripts / "preinstall"
    postinstall = scripts / "postinstall"
    swift_source = work / "OldRemoteSupport.swift"
    swift_source.write_text(
        """import AppKit
final class Delegate: NSObject, NSApplicationDelegate {}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
""",
        encoding="ascii",
    )

    target = work / "success-target"
    old_app = target / "Applications" / APP_NAME
    make_old_app(old_app, swift_source)
    config = work / "user" / "Library/Preferences/com.carriez.TECHI-Remote-Support/config.toml"
    config.parent.mkdir(parents=True)
    config.write_text("identity-preserved\n", encoding="ascii")

    unrelated = subprocess.Popen(["/bin/sleep", "60"])
    try:
        run("/usr/bin/open", "-n", old_app)
        wait_for_running(process_control, old_app)
        run("/bin/bash", preinstall, "package.pkg", "/", target)
        run(process_control, "verify-stopped", old_app)
        if unrelated.poll() is not None:
            fail("unrelated process was stopped")

        shutil.rmtree(old_app)
        shutil.copytree(new_app, old_app, symlinks=True)
        run("/bin/bash", postinstall, "package.pkg", "/", target)
        validate_app(old_app)
        run(process_control, "verify-stopped", old_app)
        if config.read_text(encoding="ascii") != "identity-preserved\n":
            fail("configuration outside the app changed")
        if (target / "private/var/tmp/al.techi.remote-support.pkg-backup").exists():
            fail("successful install left its recovery backup")
    finally:
        if unrelated.poll() is None:
            unrelated.send_signal(signal.SIGTERM)
            unrelated.wait(timeout=5)

    failed_target = work / "failed-target"
    failed_old_app = failed_target / "Applications" / APP_NAME
    make_old_app(failed_old_app, swift_source)
    run("/bin/bash", preinstall, "package.pkg", "/", failed_target)
    shutil.rmtree(failed_old_app)
    shutil.copytree(new_app, failed_old_app, symlinks=True)
    failed_plist = plist(failed_old_app)
    failed_plist["CFBundleVersion"] = "999.0"
    with (failed_old_app / "Contents/Info.plist").open("wb") as handle:
        plistlib.dump(failed_plist, handle)
    result = run("/bin/bash", postinstall, "package.pkg", "/", failed_target, check=False)
    if result.returncode == 0:
        fail("invalid post-install validation reported success")
    restored = plist(failed_old_app)
    if restored.get("CFBundleVersion") != "147.9" or not (failed_old_app / "Contents/old-install-marker").is_file():
        fail("failed post-install validation did not restore the old app")


def verify(dmg: Path, pkg: Path) -> None:
    if not dmg.is_file() or not pkg.is_file():
        fail("DMG and PKG artifacts are required")
    image_info = plistlib.loads(run("/usr/bin/hdiutil", "imageinfo", "-plist", dmg, text=False).stdout)
    if image_info.get("Format") != "UDZO" or not image_info.get("Properties", {}).get("Compressed"):
        fail("DMG is not compressed read-only UDZO")

    with tempfile.TemporaryDirectory(prefix="techi-rs-artifact-test.") as temp:
        work = Path(temp)
        attach = run("/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-plist", dmg, text=False)
        attached = plistlib.loads(attach.stdout)
        mount_points = [Path(item["mount-point"]) for item in attached["system-entities"] if "mount-point" in item]
        if len(mount_points) != 1:
            fail("DMG did not mount exactly one filesystem")
        mount = mount_points[0]
        try:
            visible = {path.name for path in mount.iterdir() if not path.name.startswith(".")}
            if visible != {APP_NAME, "Applications"}:
                fail(f"unexpected visible DMG layout: {sorted(visible)}")
            applications = mount / "Applications"
            if not applications.is_symlink() or os.readlink(applications) != "/Applications":
                fail("DMG Applications shortcut is not the canonical symlink")
            mounted_app = mount / APP_NAME
            validate_app(mounted_app)

            isolated_app = work / "Applications" / APP_NAME
            isolated_app.parent.mkdir(parents=True)
            isolated_app.mkdir()
            (isolated_app / "stale-old-file").write_text("old\n", encoding="ascii")
            shutil.rmtree(isolated_app)
            shutil.copytree(mounted_app, isolated_app, symlinks=True)
            if (isolated_app / "stale-old-file").exists():
                fail("isolated app replacement retained old bundle files")
            validate_app(isolated_app)

            expanded = work / "expanded"
            run("/usr/sbin/pkgutil", "--expand-full", pkg, expanded)
            components = [path for path in expanded.iterdir() if path.name.endswith(".component.pkg")]
            if len(components) != 1:
                fail("PKG does not contain exactly one component package")
            component = components[0]
            payload = component / "Payload"
            payload_entries = [path.relative_to(payload).as_posix() for path in payload.rglob("*")]
            if not payload_entries or payload_entries[0] != "Applications":
                fail("PKG payload does not begin at /Applications")
            payload_app = payload / "Applications" / APP_NAME
            validate_app(payload_app)
            if any(path.name == APP_NAME and path != payload_app for path in payload.rglob(APP_NAME)):
                fail("PKG contains a nested or duplicate application bundle")

            package_info = ET.parse(component / "PackageInfo").getroot()
            if package_info.get("install-location") != "/" or package_info.get("version") != BUILD_VERSION:
                fail("PKG install location or internal version is incorrect")
            bundle = package_info.find("bundle")
            if bundle is None or bundle.get("path") != f"./Applications/{APP_NAME}" or bundle.get("id") != BUNDLE_ID:
                fail("PKG component bundle identity is incorrect")
            if package_info.find("upgrade-bundle/bundle") is None or package_info.find("strict-identifier/bundle") is None:
                fail("PKG is not configured for strict atomic bundle replacement")
            bom = run("/usr/bin/lsbom", component / "Bom").stdout.splitlines()
            unexpected_owner = next(
                (line for line in bom if len(line.split("\t")) < 3 or line.split("\t")[2] != "0/0"),
                None,
            )
            if not bom or unexpected_owner:
                fail(f"PKG payload ownership is not root:wheel: {unexpected_owner or 'empty BOM'}")

            script_text = "\n".join(
                (component / "Scripts" / name).read_text(encoding="utf-8")
                for name in ("preinstall", "postinstall")
            )
            for forbidden in ("pkill", "killall", "~/Library", "Library/Preferences", "xattr", "password=", "token="):
                if forbidden.lower() in script_text.lower():
                    fail(f"forbidden package-script behavior: {forbidden}")
            for required in ("package-process-control", "lsregister", "verify-registration", "restore_previous_app"):
                if required not in script_text:
                    fail(f"missing package-script contract: {required}")

            exercise_pkg_scripts(component, payload_app, work)

            process_control = component / "Scripts/package-process-control"
            run(LSREGISTER, "-f", isolated_app)
            try:
                registration_dump = run(LSREGISTER, "-dump").stdout
                path_marker = f"path:                       {isolated_app.resolve()}"
                registration_start = registration_dump.find(path_marker)
                registration_block = registration_dump[registration_start:registration_start + 16000]
                if registration_start < 0 or "techiremotesupport:" not in registration_block:
                    fail("LaunchServices did not register the copied app URL scheme")
            finally:
                run(LSREGISTER, "-u", isolated_app, check=False)
                installed = Path("/Applications") / APP_NAME
                if installed.exists():
                    run(LSREGISTER, "-f", installed, check=False)
        finally:
            run("/usr/bin/hdiutil", "detach", mount, check=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dmg", type=Path, required=True)
    parser.add_argument("--pkg", type=Path, required=True)
    args = parser.parse_args()
    try:
        verify(args.dmg.resolve(), args.pkg.resolve())
    except (RuntimeError, OSError, subprocess.SubprocessError, KeyError, ValueError) as exc:
        print(f"macOS Remote Support artifact verification failed: {exc}", file=sys.stderr)
        return 1
    print("macOS Remote Support DMG/PKG artifact verification: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
