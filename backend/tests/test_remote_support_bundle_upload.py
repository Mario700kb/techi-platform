import hashlib
import io
import json
import zipfile

import pytest

from app.core.config import settings
from app.services.agent_package_service import AgentPackageService


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_PACKAGE_STORAGE_DIR", str(tmp_path))
    return AgentPackageService()


def bundle_pair(*, content=b"MZ canonical", manifest_overrides=None):
    rel = "TECHI Remote Support/TECHI Remote Support.exe"
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(rel, content)
    bundle = out.getvalue()
    manifest = {
        "schema_version": 1,
        "payload_format_version": 1,
        "product": "TECHI Remote Support",
        "product_root": "TECHI Remote Support",
        "version": "1.4.6",
        "platform": "windows",
        "architecture": "amd64",
        "entrypoint": rel,
        "service_name": "TECHI Remote Support",
        "service_arguments": ["--service"],
        "tray_task_name": "TECHI Remote Support Tray",
        "tray_arguments": ["--tray"],
        "expected_relative_files": [{
            "path": rel,
            "sha256": hashlib.sha256(content).hexdigest(),
            "size": len(content),
            "executable": True,
            "signed": False,
        }],
        "bundle_sha256": hashlib.sha256(bundle).hexdigest(),
        "build_commit": "abc123",
        "build_timestamp": "2020-01-01T00:00:00Z",
        "publisher": "TECHI",
        "config_paths_to_preserve": [],
        "never_overwrite_paths": [],
        "minimum_supported_windows": "10",
        "signing_status": "unsigned",
    }
    if manifest_overrides:
        manifest.update(manifest_overrides)
    return bundle, json.dumps(manifest, separators=(",", ":")).encode()


def upload(svc, bundle, manifest):
    return svc.upload(
        version="1.4.6",
        platform="windows-amd64",
        file_type="remote_support_bundle",
        filename="TECHI-Remote-Support-1.4.6-windows-amd64.zip",
        uploaded_by="tester",
        stream=io.BytesIO(bundle),
        manifest_filename="TECHI-Remote-Support-1.4.6-windows-amd64.manifest.json",
        manifest_stream=io.BytesIO(manifest),
    )


def test_upload_binds_zip_manifest_and_metadata(svc):
    bundle, manifest = bundle_pair()
    package = upload(svc, bundle, manifest)
    assert package.sha256 == hashlib.sha256(bundle).hexdigest()
    assert package.manifest_sha256 == hashlib.sha256(manifest).hexdigest()
    assert package.bundle_metadata["product_root"] == "TECHI Remote Support"
    assert package.bundle_metadata["service_arguments"] == ["--service"]
    svc.set_active(package.id, True)


def test_agent_and_remote_support_packages_activate_independently(svc):
    agent = svc.upload(
        version="2.1.8",
        platform="windows-amd64",
        file_type="msi",
        filename="TECHI-Agent-2.1.8.msi",
        uploaded_by="tester",
        stream=io.BytesIO(b"agent-only"),
    )
    remote = svc.upload(
        version="1.4.6",
        platform="windows-amd64",
        file_type="remote_support_msi",
        filename="TECHI-Remote-Support-1.4.6.msi",
        uploaded_by="tester",
        stream=io.BytesIO(b"remote-support-only"),
    )

    svc.set_active(agent.id, True)
    svc.set_active(remote.id, True)

    assert svc.latest_active("windows-amd64", file_type="msi").id == agent.id
    assert svc.latest_active("windows-amd64", file_type="remote_support_msi").id == remote.id


@pytest.mark.parametrize(
    "bundle,manifest,error",
    [
        (b"", b"{}", "empty"),
        (b"not a zip", bundle_pair(manifest_overrides={"bundle_sha256": hashlib.sha256(b"not a zip").hexdigest()})[1], "not a valid ZIP"),
        (bundle_pair()[0], b"not json", "Malformed"),
    ],
)
def test_upload_rejects_empty_nonzip_and_malformed(svc, bundle, manifest, error):
    with pytest.raises(ValueError, match=error):
        upload(svc, bundle, manifest)


def test_upload_requires_manifest(svc):
    bundle, _ = bundle_pair()
    with pytest.raises(ValueError, match="requires its manifest"):
        svc.upload(
            version="1.4.6", platform="windows-amd64", file_type="remote_support_bundle",
            filename="TECHI-Remote-Support-1.4.6-windows-amd64.zip",
            uploaded_by="tester", stream=io.BytesIO(bundle),
        )


def test_upload_rejects_manifest_and_zip_mismatch(svc):
    bundle, manifest = bundle_pair(manifest_overrides={"bundle_sha256": "0" * 64})
    with pytest.raises(ValueError, match="bundle_sha256"):
        upload(svc, bundle, manifest)


def test_upload_rejects_corrupted_entry_bytes(svc):
    bundle, manifest = bundle_pair()
    doc = json.loads(manifest)
    doc["expected_relative_files"][0]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="entry bytes"):
        upload(svc, bundle, json.dumps(doc).encode())


def test_upload_rejects_corrupted_zip_bytes(svc):
    bundle, manifest = bundle_pair()
    corrupted = bundle[:-9]
    doc = json.loads(manifest)
    doc["bundle_sha256"] = hashlib.sha256(corrupted).hexdigest()
    with pytest.raises(ValueError, match="not a valid ZIP"):
        upload(svc, corrupted, json.dumps(doc).encode())


def test_upload_rejects_duplicate_manifest_keys(svc):
    bundle, manifest = bundle_pair()
    ambiguous = manifest.replace(b'"schema_version":1', b'"schema_version":1,"schema_version":1', 1)
    with pytest.raises(ValueError, match="Duplicate"):
        upload(svc, bundle, ambiguous)


def test_activation_revalidates_exact_sidecar(svc):
    bundle, manifest = bundle_pair()
    package = upload(svc, bundle, manifest)
    sidecar = svc.package_path(package).parent / package.manifest_filename
    sidecar.write_bytes(manifest + b" ")
    with pytest.raises(ValueError, match="identity changed"):
        svc.set_active(package.id, True)


def test_upload_rejects_noncanonical_root_and_windows_alias(svc):
    bundle, manifest = bundle_pair(manifest_overrides={"product_root": "wrong"})
    with pytest.raises(ValueError, match="product_root"):
        upload(svc, bundle, manifest)

    rel = "TECHI Remote Support/CON.txt"
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr(rel, b"x")
    doc = json.loads(bundle_pair()[1])
    doc["bundle_sha256"] = hashlib.sha256(out.getvalue()).hexdigest()
    doc["expected_relative_files"] = [{
        "path": rel, "sha256": hashlib.sha256(b"x").hexdigest(), "size": 1,
        "executable": False, "signed": False,
    }]
    with pytest.raises(ValueError, match="Reserved Windows name"):
        upload(svc, out.getvalue(), json.dumps(doc).encode())
