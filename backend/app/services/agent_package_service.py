import hashlib
import json
import os
import re
import shutil
import stat
import zipfile
import zlib
from datetime import datetime
from app.core.time import utcnow
from pathlib import Path
from typing import Any, BinaryIO, List, Optional
from uuid import uuid4

from app.core.config import settings
from app.schemas.agent_package import AgentFileType, AgentPackageOut, AgentPackagePlatform


ALLOWED_PLATFORMS = {platform.value for platform in AgentPackagePlatform}
# .bin = a raw Linux agent binary (served as-is; the installer chmod +x's it).
# Windows artifacts keep their existing extensions unchanged.
ALLOWED_EXTENSIONS = (".msi", ".exe", ".zip", ".tar.gz", ".tgz", ".bin", ".dmg", ".pkg")
ALLOWED_FILE_TYPES = {ft.value for ft in AgentFileType}


class AgentPackageService:
    def __init__(self) -> None:
        self.root = Path(settings.AGENT_PACKAGE_STORAGE_DIR).resolve()
        self.files_dir = self.root / "files"
        self.manifest_path = self.root / "manifest.json"

    def list_packages(self, *, include_inactive: bool = False) -> List[AgentPackageOut]:
        packages = [self._to_out(item) for item in self._read_manifest()]
        if not include_inactive:
            packages = [package for package in packages if package.is_active]
        return sorted(packages, key=lambda item: item.uploaded_at, reverse=True)

    def get(self, package_id: str) -> Optional[AgentPackageOut]:
        for item in self._read_manifest():
            if item.get("id") == package_id:
                return self._to_out(item)
        return None

    def latest_active(self, platform: str, *, file_type: Optional[str] = None) -> Optional[AgentPackageOut]:
        packages = [
            package
            for package in self.list_packages(include_inactive=False)
            if package.platform.value == platform
            and (file_type is None or package.file_type.value == file_type)
        ]
        return packages[0] if packages else None

    def package_path(self, package: AgentPackageOut) -> Path:
        path = (self.files_dir / package.id / package.filename).resolve()
        if not str(path).startswith(str(self.files_dir.resolve())):
            raise ValueError("Invalid package path")
        return path

    def upload(
        self,
        *,
        version: str,
        platform: str,
        filename: str,
        uploaded_by: str,
        stream: BinaryIO,
        file_type: str = "msi",
        build_version: str = "",
        manifest_filename: str = "",
        manifest_stream: Optional[BinaryIO] = None,
    ) -> AgentPackageOut:
        version = version.strip()
        platform = platform.strip()
        file_type = file_type.strip()
        build_version = build_version.strip()
        safe_filename = self._safe_filename(filename)
        self._validate_version(version)
        self._validate_platform(platform)
        self._validate_extension(safe_filename)
        self._validate_file_type(file_type)
        macos_types = {
            AgentFileType.REMOTE_SUPPORT_DMG.value,
            AgentFileType.REMOTE_SUPPORT_PKG.value,
        }
        if file_type in macos_types and platform != AgentPackagePlatform.DARWIN_ARM64.value:
            raise ValueError("macOS Remote Support package requires darwin-arm64 platform")
        if file_type in macos_types:
            self._validate_build_version(build_version)
        canonical_version = self._canonical_package_version(version, safe_filename, file_type, strict=True)

        safe_manifest_filename = ""
        if file_type == AgentFileType.REMOTE_SUPPORT_BUNDLE.value:
            if manifest_stream is None:
                raise ValueError("Remote Support bundle upload requires its manifest sidecar")
            safe_manifest_filename = self._safe_filename(manifest_filename)
            expected_manifest = safe_filename[:-4] + ".manifest.json"
            if safe_manifest_filename.lower() != expected_manifest.lower():
                raise ValueError(f"Remote Support manifest filename must be {expected_manifest}")
        elif manifest_stream is not None or manifest_filename:
            raise ValueError("Manifest sidecar is only valid for remote_support_bundle")

        package_id = uuid4().hex
        package_dir = self.files_dir / package_id
        package_dir.mkdir(parents=True, exist_ok=False)
        package_path = package_dir / safe_filename

        try:
            sha256 = self._write_and_hash(stream, package_path)
            if package_path.stat().st_size == 0:
                raise ValueError("Package file is empty")
            for existing in self._read_manifest():
                if (
                    existing.get("platform") == platform
                    and existing.get("file_type", "msi") == file_type
                    and existing.get("version") == canonical_version
                    and existing.get("build_version") == build_version
                    and existing.get("sha256") != sha256
                ):
                    raise ValueError("Different package bytes already exist for this macOS build version")

            manifest_sha256 = None
            bundle_metadata = None
            if file_type == AgentFileType.REMOTE_SUPPORT_BUNDLE.value:
                manifest_path = package_dir / safe_manifest_filename
                manifest_sha256 = self._write_and_hash(manifest_stream, manifest_path)  # type: ignore[arg-type]
                if manifest_path.stat().st_size == 0:
                    raise ValueError("Remote Support manifest is empty")
                bundle_metadata = self._validate_remote_support_bundle(
                    package_path=package_path,
                    manifest_path=manifest_path,
                    version=canonical_version,
                    package_sha256=sha256,
                )
        except Exception:
            shutil.rmtree(package_dir, ignore_errors=True)
            raise

        item = {
            "id": package_id,
            "version": canonical_version,
            "platform": platform,
            "file_type": file_type,
            "filename": safe_filename,
            "uploaded_at": utcnow().isoformat(),
            "uploaded_by": uploaded_by,
            "is_active": False,
            "sha256": sha256,
        }
        if build_version:
            item["build_version"] = build_version
        if safe_manifest_filename:
            item["manifest_filename"] = safe_manifest_filename
            item["manifest_sha256"] = manifest_sha256
            item["bundle_metadata"] = bundle_metadata
        manifest = self._read_manifest()
        manifest.append(item)
        self._write_manifest(manifest)
        return self._to_out(item)

    def set_active(self, package_id: str, is_active: bool) -> AgentPackageOut:
        manifest = self._read_manifest()
        target = None
        for item in manifest:
            if item.get("id") == package_id:
                target = item
                break
        if target is None:
            raise ValueError("Package not found")

        if is_active:
            target_ft = target.get("file_type", "msi")
            if target_ft == AgentFileType.REMOTE_SUPPORT_BUNDLE.value:
                self._revalidate_bundle_item(target)
            for item in manifest:
                if item.get("platform") == target.get("platform") and item.get("file_type", "msi") == target_ft:
                    item["is_active"] = False
        target["is_active"] = is_active
        self._write_manifest(manifest)
        return self._to_out(target)

    def delete(self, package_id: str, *, confirm_active: bool = False) -> AgentPackageOut:
        manifest = self._read_manifest()
        target = None
        remaining = []
        for item in manifest:
            if item.get("id") == package_id:
                target = item
            else:
                remaining.append(item)
        if target is None:
            raise ValueError("Package not found")
        if bool(target.get("is_active", False)) and not confirm_active:
            raise ValueError("Active package requires confirmation before delete")

        package = self._to_out(target)
        self._write_manifest(remaining)
        package_dir = (self.files_dir / package.id).resolve()
        if str(package_dir).startswith(str(self.files_dir.resolve())) and package_dir.exists():
            shutil.rmtree(package_dir)
        return package

    def download_url(self, package_id: str) -> str:
        return f"{settings.API_PREFIX}/agent-packages/{package_id}/download"

    def latest_download_url(self, platform: str) -> str:
        return f"{settings.API_PREFIX}/agent-packages/platform/{platform}/download"

    def agent_binary_download_url(self) -> str:
        return f"{settings.API_PREFIX}/agent-packages/agent-binary/download"

    def agent_update_msi_download_url(self) -> str:
        return f"{settings.API_PREFIX}/agent-packages/agent-update-msi/download"

    def remote_support_msi_download_url(self) -> str:
        return f"{settings.API_PREFIX}/agent-packages/remote-support-msi/download"

    def remote_support_download_url(self, platform: str) -> str:
        return f"{settings.API_PREFIX}/agent-packages/remote-support/{platform}/download"

    def _read_manifest(self) -> List[dict]:
        if not self.manifest_path.exists():
            return []
        with self.manifest_path.open("r", encoding="utf-8") as file:
            data = json.load(file)
        if not isinstance(data, list):
            return []
        return data

    def _write_manifest(self, items: List[dict]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.files_dir.mkdir(parents=True, exist_ok=True)
        temp_path = self.manifest_path.with_suffix(".tmp")
        with temp_path.open("w", encoding="utf-8") as file:
            json.dump(items, file, indent=2)
        os.replace(temp_path, self.manifest_path)

    def _to_out(self, item: dict) -> AgentPackageOut:
        file_type = item.get("file_type", "msi")
        filename = item["filename"]
        version = self._canonical_package_version(item["version"], filename, file_type)
        return AgentPackageOut(
            id=item["id"],
            version=version,
            platform=AgentPackagePlatform(item["platform"]),
            file_type=AgentFileType(file_type),
            filename=filename,
            uploaded_at=datetime.fromisoformat(item["uploaded_at"]),
            uploaded_by=item.get("uploaded_by"),
            is_active=bool(item.get("is_active", False)),
            download_url=self.download_url(item["id"]),
            sha256=item.get("sha256"),
            build_version=item.get("build_version"),
            manifest_filename=item.get("manifest_filename"),
            manifest_sha256=item.get("manifest_sha256"),
            bundle_metadata=item.get("bundle_metadata"),
        )

    def _revalidate_bundle_item(self, item: dict) -> None:
        package = self._to_out(item)
        package_path = self.package_path(package)
        manifest_filename = item.get("manifest_filename")
        if not manifest_filename:
            raise ValueError("Remote Support bundle has no bound manifest")
        manifest_path = package_path.parent / self._safe_filename(manifest_filename)
        if not package_path.is_file() or not manifest_path.is_file():
            raise ValueError("Remote Support bundle or manifest file is missing")
        package_sha = self._hash_path(package_path)
        manifest_sha = self._hash_path(manifest_path)
        if package_sha != item.get("sha256") or manifest_sha != item.get("manifest_sha256"):
            raise ValueError("Remote Support bundle identity changed after upload")
        metadata = self._validate_remote_support_bundle(
            package_path=package_path,
            manifest_path=manifest_path,
            version=item["version"],
            package_sha256=package_sha,
        )
        if metadata != item.get("bundle_metadata"):
            raise ValueError("Remote Support bundle validated metadata changed after upload")

    @staticmethod
    def _hash_path(path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    @classmethod
    def _validate_remote_support_bundle(
        cls, *, package_path: Path, manifest_path: Path, version: str, package_sha256: str
    ) -> dict[str, Any]:
        if manifest_path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Remote Support manifest exceeds 8 MiB")
        def reject_duplicate_keys(pairs):
            out = {}
            for key, value in pairs:
                if key in out:
                    raise ValueError(f"Duplicate Remote Support manifest key: {key}")
                out[key] = value
            return out
        try:
            manifest = json.loads(
                manifest_path.read_text(encoding="utf-8"),
                object_pairs_hook=reject_duplicate_keys,
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"Malformed Remote Support manifest: {exc}") from exc
        if not isinstance(manifest, dict):
            raise ValueError("Remote Support manifest must be a JSON object")
        allowed = {
            "schema_version", "payload_format_version", "product", "product_root", "version",
            "platform", "architecture", "entrypoint", "service_name", "service_arguments",
            "tray_task_name", "tray_arguments", "expected_relative_files", "bundle_sha256",
            "build_commit", "build_timestamp", "publisher", "config_paths_to_preserve",
            "never_overwrite_paths", "minimum_supported_windows", "signing_status",
        }
        unknown = set(manifest) - allowed
        if unknown:
            raise ValueError(f"Remote Support manifest has unknown fields: {sorted(unknown)}")
        exact = {
            "schema_version": 1,
            "payload_format_version": 1,
            "product": "TECHI Remote Support",
            "product_root": "TECHI Remote Support",
            "version": version,
            "platform": "windows",
            "architecture": "amd64",
            "entrypoint": "TECHI Remote Support/TECHI Remote Support.exe",
            "service_name": "TECHI Remote Support",
            "service_arguments": ["--service"],
            "tray_task_name": "TECHI Remote Support Tray",
            "tray_arguments": ["--tray"],
        }
        for key, expected in exact.items():
            if manifest.get(key) != expected:
                raise ValueError(f"Remote Support manifest {key} does not match canonical metadata")
        if manifest.get("bundle_sha256") != package_sha256:
            raise ValueError("Remote Support manifest bundle_sha256 does not match ZIP bytes")
        entries = manifest.get("expected_relative_files")
        if not isinstance(entries, list) or not entries or len(entries) > 5000:
            raise ValueError("Remote Support manifest file list is empty or too large")

        expected: dict[str, dict] = {}
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) - {"path", "sha256", "size", "executable", "signed"}:
                raise ValueError("Malformed Remote Support manifest file entry")
            rel = entry.get("path")
            cls._validate_bundle_relpath(rel)
            if not rel.startswith("TECHI Remote Support/"):
                raise ValueError("Remote Support manifest file is outside product_root")
            key = rel.casefold()
            if key in expected:
                raise ValueError("Remote Support manifest has case-insensitive duplicate paths")
            digest, size = entry.get("sha256"), entry.get("size")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("Remote Support manifest file has invalid sha256")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > 512 * 1024 * 1024:
                raise ValueError("Remote Support manifest file has invalid size")
            executable = entry.get("executable", False)
            if not isinstance(executable, bool) or not isinstance(entry.get("signed"), bool):
                raise ValueError("Remote Support manifest file flags must be booleans")
            if executable != rel.lower().endswith(".exe"):
                raise ValueError("Remote Support manifest executable flag does not match path")
            expected[key] = entry

        try:
            with zipfile.ZipFile(package_path, "r") as archive:
                infos = archive.infolist()
                if not infos or len(infos) > 5000:
                    raise ValueError("Remote Support ZIP is empty or has too many entries")
                actual: dict[str, zipfile.ZipInfo] = {}
                total = 0
                for info in infos:
                    if info.is_dir():
                        raise ValueError("Remote Support ZIP must not contain directory entries")
                    cls._validate_bundle_relpath(info.filename)
                    key = info.filename.casefold()
                    if key in actual:
                        raise ValueError("Remote Support ZIP has case-insensitive duplicate paths")
                    if info.flag_bits & 1:
                        raise ValueError("Encrypted Remote Support ZIP entries are forbidden")
                    mode = (info.external_attr >> 16) & 0o170000
                    if mode == stat.S_IFLNK:
                        raise ValueError("Remote Support ZIP symlink entries are forbidden")
                    if info.file_size > 512 * 1024 * 1024:
                        raise ValueError("Remote Support ZIP entry exceeds size limit")
                    total += info.file_size
                    if total > 1536 * 1024 * 1024:
                        raise ValueError("Remote Support ZIP expanded size exceeds limit")
                    actual[key] = info
                if set(actual) != set(expected):
                    raise ValueError("Remote Support ZIP file set does not match manifest")
                for key, info in actual.items():
                    entry = expected[key]
                    if info.filename != entry["path"] or info.file_size != entry["size"]:
                        raise ValueError("Remote Support ZIP entry metadata does not match manifest")
                    h = hashlib.sha256()
                    read = 0
                    with archive.open(info, "r") as source:
                        for chunk in iter(lambda: source.read(65536), b""):
                            read += len(chunk)
                            if read > 512 * 1024 * 1024:
                                raise ValueError("Remote Support ZIP entry exceeds size limit")
                            h.update(chunk)
                    if read != entry["size"] or h.hexdigest() != entry["sha256"]:
                        raise ValueError("Remote Support ZIP entry bytes do not match manifest")
        except (zipfile.BadZipFile, zlib.error, EOFError, RuntimeError) as exc:
            raise ValueError("Remote Support payload is not a valid ZIP") from exc

        return {
            key: manifest[key]
            for key in ("schema_version", "payload_format_version", "product", "product_root", "version",
                        "platform", "architecture", "entrypoint", "service_name", "service_arguments",
                        "tray_task_name", "tray_arguments")
        }

    @staticmethod
    def _validate_bundle_relpath(value: Any) -> None:
        if not isinstance(value, str) or not value or value != value.strip() or "\\" in value or value.startswith("/"):
            raise ValueError("Unsafe Remote Support bundle path")
        reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
        for segment in value.split("/"):
            if not segment or segment in {".", ".."} or segment.rstrip(". ") != segment:
                raise ValueError("Unsafe Remote Support bundle path segment")
            if any(ord(ch) < 32 for ch in segment) or any(ch in '<>:"|?*' for ch in segment):
                raise ValueError("Illegal Windows character in Remote Support bundle path")
            if segment.split(".", 1)[0].casefold() in reserved:
                raise ValueError("Reserved Windows name in Remote Support bundle path")

    @staticmethod
    def _write_and_hash(stream: BinaryIO, dest: Path) -> str:
        """Write stream to dest and return the hex SHA-256 digest."""
        h = hashlib.sha256()
        with dest.open("wb") as out:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
        return h.hexdigest()

    @staticmethod
    def _safe_filename(filename: str) -> str:
        name = Path(filename).name
        if name != filename or name in {"", ".", ".."}:
            raise ValueError("Invalid filename")
        return name

    @staticmethod
    def _validate_version(version: str) -> None:
        if not version or len(version) > 64:
            raise ValueError("Invalid package version")
        if not re.match(r"^[A-Za-z0-9._+\-]+$", version):
            raise ValueError("Package version contains unsupported characters")

    @staticmethod
    def _validate_platform(platform: str) -> None:
        if platform not in ALLOWED_PLATFORMS:
            raise ValueError("Unsupported package platform")

    @staticmethod
    def _validate_build_version(build_version: str) -> None:
        if not build_version or len(build_version) > 32 or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", build_version):
            raise ValueError("macOS Remote Support package requires a numeric internal build version")

    @staticmethod
    def _validate_extension(filename: str) -> None:
        lowered = filename.lower()
        if not any(lowered.endswith(ext) for ext in ALLOWED_EXTENSIONS):
            raise ValueError("Unsupported package file extension")

    @staticmethod
    def _validate_file_type(file_type: str) -> None:
        if file_type not in ALLOWED_FILE_TYPES:
            raise ValueError(f"Unsupported file_type '{file_type}'. Allowed: {sorted(ALLOWED_FILE_TYPES)}")

    @classmethod
    def _canonical_package_version(cls, version: str, filename: str, file_type: str, *, strict: bool = False) -> str:
        if file_type == AgentFileType.REMOTE_SUPPORT_BUNDLE.value:
            filename_version = cls._remote_support_version_from_bundle_filename(filename)
            if filename_version is None:
                raise ValueError(
                    "Remote Support bundle filename must be "
                    "TECHI-Remote-Support-<version>-windows-amd64.zip"
                )
            if strict and version != filename_version:
                raise ValueError("Remote Support bundle version must match filename")
            return filename_version
        if file_type in {
            AgentFileType.REMOTE_SUPPORT_DMG.value,
            AgentFileType.REMOTE_SUPPORT_PKG.value,
        }:
            extension = "dmg" if file_type == AgentFileType.REMOTE_SUPPORT_DMG.value else "pkg"
            filename_version = cls._remote_support_macos_version(filename, extension)
            if filename_version is None:
                raise ValueError(
                    "macOS Remote Support filename must be "
                    f"TECHI-Remote-Support-<version>-darwin-arm64.{extension}"
                )
            if strict and version != filename_version:
                raise ValueError("macOS Remote Support version must match filename")
            return filename_version
        if file_type != AgentFileType.REMOTE_SUPPORT_MSI.value:
            return version
        filename_version = cls._remote_support_version_from_filename(filename)
        if filename_version is None:
            raise ValueError("Remote Support MSI filename must be TECHI-Remote-Support-<version>.msi")
        if strict and version != filename_version:
            raise ValueError("Remote Support MSI version must match filename")
        return filename_version

    @staticmethod
    def _remote_support_version_from_filename(filename: str) -> Optional[str]:
        match = re.match(r"^TECHI-Remote-Support-([A-Za-z0-9._+\-]+)\.msi$", filename, re.IGNORECASE)
        return match.group(1) if match else None

    @staticmethod
    def _remote_support_macos_version(filename: str, extension: str) -> Optional[str]:
        match = re.match(
            rf"^TECHI-Remote-Support-([A-Za-z0-9._+\-]+)-darwin-arm64\.{re.escape(extension)}$",
            filename,
            re.IGNORECASE,
        )
        return match.group(1) if match else None

    @staticmethod
    def _remote_support_version_from_bundle_filename(filename: str) -> Optional[str]:
        match = re.match(
            r"^TECHI-Remote-Support-(\d+\.\d+\.\d+)-windows-amd64\.zip$",
            filename,
            re.IGNORECASE,
        )
        return match.group(1) if match else None
