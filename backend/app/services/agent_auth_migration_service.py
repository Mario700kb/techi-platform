import base64
import hashlib
import secrets
from datetime import timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from sqlalchemy.orm import Session

from app.core.agent_auth import issue_agent_credential
from app.core.config import settings
from app.core.time import utcnow
from app.models.device import Device
from app.services.device_activity_event_service import DeviceActivityEventService


class AgentAuthMigrationError(ValueError):
    pass


class AgentAuthMigrationService:
    CHALLENGE_TTL_SECONDS = 120

    def __init__(self, db: Session):
        self.db = db

    @staticmethod
    def allowed(device_id: int) -> bool:
        mode = settings.AGENT_AUTH_MIGRATION_MODE
        if mode == "fleet":
            return True
        if mode != "canary":
            return False
        allowed = {int(value) for value in settings.AGENT_AUTH_MIGRATION_DEVICE_IDS.split(",") if value}
        return device_id in allowed

    def challenge(self, *, device_id: int, agent_id: str, public_key: str) -> dict:
        device, key, fingerprint = self._identity(device_id, agent_id, public_key)
        existing = device.agent_auth_migration_fingerprint
        if existing and existing != fingerprint:
            raise AgentAuthMigrationError("migration_key_mismatch")
        challenge = secrets.token_urlsafe(32)
        device.agent_auth_migration_public_key = public_key
        device.agent_auth_migration_fingerprint = fingerprint
        device.agent_auth_migration_challenge_hash = hashlib.sha256(challenge.encode()).hexdigest()
        device.agent_auth_migration_challenge_expires_at = utcnow() + timedelta(seconds=self.CHALLENGE_TTL_SECONDS)
        if device.agent_auth_migration_approved_at is None:
            device.agent_auth_migration_status = "challenge_issued"
        self.db.add(device)
        self.db.commit()
        return {"challenge": challenge, "fingerprint": fingerprint, "expires_in_seconds": self.CHALLENGE_TTL_SECONDS}

    def prove(self, *, device_id: int, agent_id: str, public_key: str, challenge: str, signature: str) -> dict:
        device, key, fingerprint = self._identity(device_id, agent_id, public_key)
        if device.agent_auth_migration_fingerprint != fingerprint:
            raise AgentAuthMigrationError("migration_key_mismatch")
        expected = device.agent_auth_migration_challenge_hash
        expires = device.agent_auth_migration_challenge_expires_at
        now = utcnow()
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=now.tzinfo)
        if not expected or not expires or expires < now:
            raise AgentAuthMigrationError("migration_challenge_expired")
        if not secrets.compare_digest(expected, hashlib.sha256(challenge.encode()).hexdigest()):
            raise AgentAuthMigrationError("migration_challenge_mismatch")
        try:
            signature_bytes = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
            key.verify(
                signature_bytes,
                challenge.encode(),
                padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH),
                hashes.SHA256(),
            )
        except (InvalidSignature, ValueError) as exc:
            raise AgentAuthMigrationError("migration_proof_invalid") from exc
        device.agent_auth_migration_challenge_hash = None
        device.agent_auth_migration_challenge_expires_at = None
        now = utcnow()
        if device.agent_auth_migration_proof_verified_at is None:
            device.agent_auth_migration_proof_verified_at = now
            self._event(device.id, "agent_auth_migration_proof_verified", "Agent authentication migration proof verified")
        if device.agent_auth_migration_approved_at is None:
            device.agent_auth_migration_status = "pending_approval"
            self.db.add(device)
            self.db.commit()
            return {"status": "pending_approval", "fingerprint": fingerprint}

        credential = issue_agent_credential(device)
        encrypted = key.encrypt(
            credential.encode(),
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )
        device.agent_auth_migration_status = "completed"
        device.agent_auth_migration_completed_at = now
        self.db.add(device)
        self.db.commit()
        self._event(device.id, "agent_auth_migration_completed", "Agent authentication migration completed")
        return {
            "status": "completed",
            "fingerprint": fingerprint,
            "encrypted_credential": base64.urlsafe_b64encode(encrypted).decode().rstrip("="),
        }

    def approve(self, device: Device, fingerprint: str) -> None:
        if not self.allowed(device.id):
            raise AgentAuthMigrationError("migration_not_allowed")
        if not device.agent_auth_migration_proof_verified_at:
            raise AgentAuthMigrationError("migration_proof_required")
        if not device.agent_auth_migration_fingerprint or not secrets.compare_digest(
            device.agent_auth_migration_fingerprint, fingerprint.lower()
        ):
            raise AgentAuthMigrationError("migration_fingerprint_mismatch")
        if device.agent_auth_migration_approved_at is None:
            device.agent_auth_migration_approved_at = utcnow()
            device.agent_auth_migration_status = "approved"
            self.db.add(device)
            self.db.commit()
            self._event(device.id, "agent_auth_migration_approved", "Agent authentication migration approved", actor="operator")

    def _identity(self, device_id: int, agent_id: str, public_key: str):
        if not self.allowed(device_id):
            raise AgentAuthMigrationError("migration_not_allowed")
        device = self.db.query(Device).filter(Device.id == device_id, Device.agent_id == agent_id).first()
        if device is None:
            raise AgentAuthMigrationError("migration_identity_unknown")
        if device.agent_auth_secret_ciphertext:
            raise AgentAuthMigrationError("migration_not_required")
        try:
            der = base64.b64decode(public_key, validate=True)
            key = serialization.load_der_public_key(der)
        except (ValueError, TypeError) as exc:
            raise AgentAuthMigrationError("migration_public_key_invalid") from exc
        if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 3072:
            raise AgentAuthMigrationError("migration_public_key_invalid")
        canonical = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if canonical != der:
            raise AgentAuthMigrationError("migration_public_key_invalid")
        return device, key, hashlib.sha256(der).hexdigest()

    def _event(self, device_id: int, event_type: str, summary: str, actor: str = "agent") -> None:
        DeviceActivityEventService(self.db).record(
            device_id=device_id, event_type=event_type, summary=summary, actor=actor, fail_silently=True
        )
