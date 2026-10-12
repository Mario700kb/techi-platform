"""Two-factor authentication (TOTP) for operators.

Enrolment is two-step: `start_setup` stores a pending secret, `confirm` turns
it on only after the operator proves their app produces valid codes, so a
half-finished setup can never lock anyone out. Secrets are sealed with the
vault cipher; recovery codes are stored as SHA-256 digests and work once.
"""
import json
from typing import List, Optional

from sqlalchemy.orm import Session

from app.core import totp
from app.core.config import settings
from app.core.time import utcnow
from app.core.vault_cipher import decrypt_secret, encrypt_secret
from app.models.operator import Operator


class MfaError(Exception):
    pass


class MfaService:
    def __init__(self, db: Session):
        self.db = db

    # -- enrolment ---------------------------------------------------------

    def start_setup(self, operator: Operator) -> dict:
        if operator.mfa_enabled:
            raise MfaError("Two-factor authentication is already on")
        secret = totp.generate_secret()
        operator.mfa_pending_ciphertext, operator.mfa_pending_dek = encrypt_secret(secret)
        self.db.commit()
        account = operator.email or operator.username
        return {
            "secret": secret,
            "otpauth_uri": totp.provisioning_uri(secret, account, settings.MFA_ISSUER),
        }

    def confirm(self, operator: Operator, code: str) -> List[str]:
        if operator.mfa_enabled:
            raise MfaError("Two-factor authentication is already on")
        if not operator.mfa_pending_ciphertext or not operator.mfa_pending_dek:
            raise MfaError("Start the setup again")
        secret = decrypt_secret(operator.mfa_pending_ciphertext, operator.mfa_pending_dek)
        step = totp.verify(secret, code)
        if step is None:
            raise MfaError("That code is not valid. Check the time on your phone and try the newest code.")
        operator.mfa_secret_ciphertext = operator.mfa_pending_ciphertext
        operator.mfa_secret_dek = operator.mfa_pending_dek
        operator.mfa_pending_ciphertext = None
        operator.mfa_pending_dek = None
        operator.mfa_last_step = step
        operator.mfa_enabled = True
        operator.mfa_enabled_at = utcnow()
        codes = self._new_recovery_codes(operator)
        self.db.commit()
        return codes

    def disable(self, operator: Operator) -> None:
        operator.mfa_enabled = False
        operator.mfa_enabled_at = None
        operator.mfa_secret_ciphertext = None
        operator.mfa_secret_dek = None
        operator.mfa_pending_ciphertext = None
        operator.mfa_pending_dek = None
        operator.mfa_recovery_codes = None
        operator.mfa_last_step = None
        self.db.commit()

    def regenerate_recovery_codes(self, operator: Operator) -> List[str]:
        codes = self._new_recovery_codes(operator)
        self.db.commit()
        return codes

    # -- verification ------------------------------------------------------

    def verify(self, operator: Operator, code: str) -> Optional[str]:
        """Check a sign-in code: an authenticator code or an unused recovery
        code. Returns "totp" or "recovery_code", or None. Consumes what it
        accepts, so neither kind can be used twice."""
        if not operator.mfa_enabled or not operator.mfa_secret_ciphertext:
            return None
        secret = decrypt_secret(operator.mfa_secret_ciphertext, operator.mfa_secret_dek)
        step = totp.verify(secret, code, last_step=operator.mfa_last_step)
        if step is not None:
            operator.mfa_last_step = step
            self.db.commit()
            return "totp"

        digests = self._recovery_digests(operator)
        candidate = totp.hash_recovery_code(code)
        if candidate in digests:
            digests.remove(candidate)
            operator.mfa_recovery_codes = json.dumps(digests)
            self.db.commit()
            return "recovery_code"
        return None

    def recovery_codes_remaining(self, operator: Operator) -> int:
        return len(self._recovery_digests(operator))

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _recovery_digests(operator: Operator) -> List[str]:
        try:
            return list(json.loads(operator.mfa_recovery_codes or "[]"))
        except (TypeError, ValueError):
            return []

    @staticmethod
    def _new_recovery_codes(operator: Operator) -> List[str]:
        codes = totp.generate_recovery_codes()
        operator.mfa_recovery_codes = json.dumps([totp.hash_recovery_code(code) for code in codes])
        return codes
