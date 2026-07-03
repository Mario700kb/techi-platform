import hashlib
import json
import os
import re
import shutil
from datetime import datetime
from app.core.time import utcnow
from pathlib import Path
from typing import BinaryIO, List, Optional
from uuid import uuid4

from app.core.config import settings
from app.schemas.agent_package import AgentFileType, AgentPackageOut, AgentPackagePlatform


ALLOWED_PLATFORMS = {platform.value for platform in AgentPackagePlatform}
ALLOWED_EXTENSIONS = (".msi", ".exe", ".zip", ".tar.gz", ".tgz")
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
    ) -> AgentPackageOut:
        version = version.strip()
        platform = platform.strip()
        file_type = file_type.strip()
        safe_filename = self._safe_filename(filename)
        self._validate_version(version)
        self._validate_platform(platform)
        self._validate_extension(safe_filename)
        self._validate_file_type(file_type)

        package_id = uuid4().hex
        package_dir = self.files_dir / package_id
        package_dir.mkdir(parents=True, exist_ok=False)
        package_path = package_dir / safe_filename

        sha256 = self._write_and_hash(stream, package_path)

        item = {
            "id": package_id,
            "version": version,
            "platform": platform,
            "file_type": file_type,
            "filename": safe_filename,
            "uploaded_at": utcnow().isoformat(),
            "uploaded_by": uploaded_by,
            "is_active": False,
            "sha256": sha256,
        }
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
        return AgentPackageOut(
            id=item["id"],
            version=item["version"],
            platform=AgentPackagePlatform(item["platform"]),
            file_type=AgentFileType(item.get("file_type", "msi")),
            filename=item["filename"],
            uploaded_at=datetime.fromisoformat(item["uploaded_at"]),
            uploaded_by=item.get("uploaded_by"),
            is_active=bool(item.get("is_active", False)),
            download_url=self.download_url(item["id"]),
            sha256=item.get("sha256"),
        )

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
    def _validate_extension(filename: str) -> None:
        lowered = filename.lower()
        if not any(lowered.endswith(ext) for ext in ALLOWED_EXTENSIONS):
            raise ValueError("Unsupported package file extension")

    @staticmethod
    def _validate_file_type(file_type: str) -> None:
        if file_type not in ALLOWED_FILE_TYPES:
            raise ValueError(f"Unsupported file_type '{file_type}'. Allowed: {sorted(ALLOWED_FILE_TYPES)}")
