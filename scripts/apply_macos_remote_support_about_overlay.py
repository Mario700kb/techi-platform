#!/usr/bin/env python3

import argparse
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "remote-support-macos/client-overlay"
IMPORT_LINE = "import 'package:flutter_hbb/desktop/about_version.dart';"
SECURE_CONNECT_MARKER = "techi-secure-connect-stdin-v1"


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

    core = source_root / "src/core_main.rs"
    ipc = source_root / "src/ipc.rs"
    server = source_root / "src/server.rs"
    common = flutter / "lib/common.dart"
    model = flutter / "lib/models/model.dart"
    if not core.is_file() and not common.is_file():
        return
    if not all(path.is_file() for path in (core, ipc, server, common, model)):
        raise RuntimeError("secure connect source overlay requires Rust core/IPC/server and Flutter common/model")
    core_text = core.read_text(encoding="utf-8-sig")
    if SECURE_CONNECT_MARKER not in core_text:
        # Fresh RustDesk source: inject the dispatch and the implementation body.
        core_text = replace_once(
            core_text,
            "    crate::load_custom_client();\n",
            "    crate::load_custom_client();\n"
            "    #[cfg(all(target_os = \"macos\", feature = \"flutter\"))]\n"
            "    if std::env::args()\n"
            "        .any(|arg| arg == \"--techi-connect-stdin\" || arg == \"--techi-connect-self-test\")\n"
            "    {\n"
            "        return techi_secure_connect_from_stdin(std::env::args());\n"
            "    }\n",
            "secure connect dispatch anchor",
        )
        core_text = core_text.replace(
            '    if std::env::args().any(|arg| arg == "--techi-connect-stdin" || arg == "--techi-connect-self-test") {\n',
            '    if std::env::args()\n'
            '        .any(|arg| arg == "--techi-connect-stdin" || arg == "--techi-connect-self-test")\n'
            '    {\n',
        )
        anchor = "/// invoke a new connection\n"
        implementation = (OVERLAY / "secure_connect.rs.txt").read_text(encoding="utf-8").rstrip()
        marker_start = core_text.index("// " + SECURE_CONNECT_MARKER)
        marker_end = core_text.index(anchor, marker_start)
        core_text = core_text[:marker_start] + implementation + "\n\n" + core_text[marker_end:]
    elif "--techi-connect-stdin" not in core_text or "TECHI_CONNECT_ACCEPTED_V1" not in core_text:
        raise RuntimeError("secure connect overlay is only partially applied")
    # Idempotent: when the source already carries the secure-connect contract
    # (e.g. the techi-remote-support fork bakes it in for macOS+Windows), leave
    # core_main.rs untouched so the applier never reverts it to a macOS-only body.
    core.write_text(core_text, encoding="utf-8")

    ipc_text = ipc.read_text(encoding="utf-8-sig")
    if "TechiConnect {" not in ipc_text:
        ipc_text = replace_once(
            ipc_text,
            "    UrlLink(String),\n",
            "    UrlLink(String),\n"
            "    // techi-secure-connect-ipc-v1: structured in-memory handoff, never a URI.\n"
            "    TechiConnect { peer_id: String, credential: String },\n",
            "secure connect IPC data variant",
        )
        ipc_text = replace_once(
            ipc_text,
            "pub async fn send_url_scheme(url: String) -> ResultType<()> {\n"
            "    connect(1_000, \"_url\")\n"
            "        .await?\n"
            "        .send(&Data::UrlLink(url))\n"
            "        .await?;\n"
            "    Ok(())\n"
            "}\n",
            "pub async fn send_url_scheme(url: String) -> ResultType<()> {\n"
            "    connect(1_000, \"_url\")\n"
            "        .await?\n"
            "        .send(&Data::UrlLink(url))\n"
            "        .await?;\n"
            "    Ok(())\n"
            "}\n\n"
            "#[tokio::main(flavor = \"current_thread\")]\n"
            "pub async fn send_techi_connect(peer_id: &str, credential: &str) -> ResultType<()> {\n"
            "    connect(1_000, \"_url\")\n"
            "        .await?\n"
            "        .send(&Data::TechiConnect {\n"
            "            peer_id: peer_id.to_owned(),\n"
            "            credential: credential.to_owned(),\n"
            "        })\n"
            "        .await?;\n"
            "    Ok(())\n"
            "}\n",
            "secure connect IPC sender",
        )
    elif "send_techi_connect" not in ipc_text:
        raise RuntimeError("secure connect IPC overlay is only partially applied")
    ipc.write_text(ipc_text, encoding="utf-8")

    server_text = server.read_text(encoding="utf-8-sig")
    if '"on_techi_secure_connect"' not in server_text:
        server_text = replace_once(
            server_text,
            "                        Data::UrlLink(url) => {\n",
            "                        Data::TechiConnect { peer_id, credential } => {\n"
            "                            let event = serde_json::json!({\n"
            "                                \"name\": \"on_techi_secure_connect\",\n"
            "                                \"peer_id\": peer_id,\n"
            "                                \"credential\": credential,\n"
            "                            })\n"
            "                            .to_string();\n"
            "                            if crate::flutter::push_global_event(\n"
            "                                crate::flutter::APP_TYPE_MAIN,\n"
            "                                event,\n"
            "                            )\n"
            "                            .is_none()\n"
            "                            {\n"
            "                                log::warn!(\"No main window app found!\");\n"
            "                            }\n"
            "                        }\n"
            "                        Data::UrlLink(url) => {\n",
            "secure connect IPC receiver",
        )
    server.write_text(server_text, encoding="utf-8")

    model_text = model.read_text(encoding="utf-8-sig")
    if "on_techi_secure_connect" not in model_text:
        model_text = replace_once(
            model_text,
            "      } else if (name == 'on_url_scheme_received') {\n",
            "      } else if (name == 'on_techi_secure_connect') {\n"
            "        onTechiSecureConnect(evt);\n"
            "      } else if (name == 'on_url_scheme_received') {\n",
            "secure connect Flutter event",
        )
        model_text = replace_once(
            model_text,
            "  onUrlSchemeReceived(Map<String, dynamic> evt) {\n",
            "  onTechiSecureConnect(Map<String, dynamic> evt) {\n"
            "    final peerId = evt['peer_id']?.toString() ?? '';\n"
            "    final credential = evt['credential']?.toString() ?? '';\n"
            "    if (peerId.isEmpty || credential.isEmpty) return;\n"
            "    handleUriLink(cmdArgs: [\n"
            "      '--connect',\n"
            "      peerId,\n"
            "      '--password',\n"
            "      credential,\n"
            "    ]);\n"
            "  }\n\n"
            "  onUrlSchemeReceived(Map<String, dynamic> evt) {\n",
            "secure connect Flutter handler",
        )
    model.write_text(model_text, encoding="utf-8")

    common_text = common.read_text(encoding="utf-8-sig")
    common_text = common_text.replace(
        '    print("initialLink: $initialLink");',
        '    debugPrint("initialLink received: ${initialLink != null && initialLink.isNotEmpty}");',
    )
    common_text = common_text.replace(
        '    debugPrint("A uri was received: $uri. handleByFlutter $handleByFlutter");',
        '    debugPrint("A uri was received. handleByFlutter $handleByFlutter");',
    )
    if 'print("initialLink: $initialLink")' in common_text or 'received: $uri' in common_text:
        raise RuntimeError("credential-bearing URI logging remains")
    common.write_text(common_text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_root", type=Path)
    args = parser.parse_args()
    apply(args.source_root.resolve())
    print("macOS About bundle-metadata overlay: APPLIED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
