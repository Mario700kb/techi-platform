import logging
import re
from typing import Optional

from app.core.config import settings
from app.models.trusted_domain import TrustedDomain

logger = logging.getLogger(__name__)

# Domain values that always indicate a non-domain (workgroup) machine
_WORKGROUP_NAMES = frozenset({
    "workgroup", "mshome", "workgroup.local", "home", "localdomain",
})

# OS substrings that indicate Windows Server family
_SERVER_OS_TOKENS = ("server", "2008", "2012", "2016", "2019", "2022", "2025")

# OS substrings that indicate Windows client OS
_CLIENT_OS_TOKENS = ("windows 10", "windows 11", "windows 8", "windows 7", "vista", "xp")

# Private domain suffixes to strip when humanizing
_STRIP_SUFFIXES = (".local", ".lan", ".internal", ".home", ".corp", ".ad")


class TrustedDomainService:
    """Validates and normalizes domain names for trusted auto-enrollment."""

    def __init__(self, db=None):
        self.db = db

    def is_trusted_domain(self, domain: Optional[str], hostname: Optional[str] = None) -> bool:
        normalized = self.normalize_domain(domain)
        if not normalized or normalized in _WORKGROUP_NAMES:
            return False
        hostname_lower = (hostname or "").strip().lower()
        if normalized == hostname_lower:
            return False
        if self.db is None:
            return self.is_trusted(domain, hostname)
        configured = (
            self.db.query(TrustedDomain)
            .filter(TrustedDomain.domain == normalized, TrustedDomain.is_active.is_(True))
            .first()
        )
        if configured:
            return True
        # If explicit DB domains exist, they become the tenant boundary.
        any_configured = self.db.query(TrustedDomain.id).filter(TrustedDomain.is_active.is_(True)).first()
        if any_configured is not None:
            return False
        return self.is_trusted(domain, hostname)

    @classmethod
    def normalize_domain(cls, domain: Optional[str]) -> str:
        return (domain or "").strip().lower().rstrip(".")

    @classmethod
    def is_trusted(cls, domain: Optional[str], hostname: Optional[str] = None) -> bool:
        """Return True if the domain is eligible for token-free auto-enrollment."""
        if not settings.TRUSTED_DOMAIN_AUTO_ENROLLMENT:
            return False
        if not domain or not domain.strip():
            return False

        normalized = cls.normalize_domain(domain)
        hostname_lower = (hostname or "").strip().lower()

        # Reject workgroup names
        if normalized in _WORKGROUP_NAMES:
            return False
        # Domain must not equal hostname (means no real domain)
        if normalized and normalized == hostname_lower:
            return False

        if settings.TRUSTED_DOMAIN_ALLOWLIST:
            allowlist = {
                d.strip().lower().rstrip(".")
                for d in settings.TRUSTED_DOMAIN_ALLOWLIST.split(",")
                if d.strip()
            }
            trusted = normalized in allowlist
            if not trusted:
                logger.debug(
                    "[trusted_domain] domain '%s' not in allowlist %s", normalized, allowlist
                )
            return trusted

        # Empty allowlist is only permissive outside production. Production and
        # multi-tenant deployments must use TRUSTED_DOMAIN_ALLOWLIST or rows in
        # trusted_domains.
        return settings.ENVIRONMENT.lower() != "production"

    def get_active_domain(self, domain: Optional[str]) -> Optional[TrustedDomain]:
        if self.db is None:
            return None
        normalized = self.normalize_domain(domain)
        if not normalized:
            return None
        return (
            self.db.query(TrustedDomain)
            .filter(TrustedDomain.domain == normalized, TrustedDomain.is_active.is_(True))
            .first()
        )

    def mapped_client_id(self, domain: Optional[str]) -> Optional[int]:
        configured = self.get_active_domain(domain)
        return configured.client_id if configured and configured.client_id else None

    def mapped_client_name(self, domain: Optional[str]) -> Optional[str]:
        configured = self.get_active_domain(domain)
        if configured is None:
            return None
        if configured.client:
            return configured.client.name
        return configured.client_name or None

    @classmethod
    def normalize_to_client_name(cls, domain: str) -> str:
        """ADPascucci.local → 'Adpascucci'; corp.example.com → 'Corp'."""
        normalized = domain.strip().rstrip(".")
        lower = normalized.lower()
        for suffix in _STRIP_SUFFIXES:
            if lower.endswith(suffix):
                normalized = normalized[: -len(suffix)]
                break
        # Take only the first label (leftmost)
        label = normalized.split(".")[0]
        # Humanize: replace non-alphanumeric with spaces
        cleaned = re.sub(r"[^A-Za-z0-9]+", " ", label).strip()
        return cleaned.title() if cleaned else "Domain Client"

    @classmethod
    def detect_group_name(
        cls,
        os_name: Optional[str],
        platform: Optional[str],
        *,
        os_version: Optional[str] = None,
        os_caption: Optional[str] = None,
        windows_product_type: Optional[int] = None,
    ) -> str:
        """Return 'Servers' or 'Client PC' based on the reported OS."""
        if windows_product_type in {2, 3}:
            return "Servers"
        os_lower = " ".join(
            value.lower()
            for value in (os_name or "", os_version or "", os_caption or "")
            if value
        )
        platform_lower = (platform or "").lower()
        if any(tok in os_lower for tok in _SERVER_OS_TOKENS):
            return "Servers"
        if "darwin" in platform_lower or "mac" in os_lower:
            return "Mac Devices"
        if "linux" in platform_lower or "linux" in os_lower:
            return "Linux Devices"
        return "Client PC"
