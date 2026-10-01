"""Shared, conservative output handling for stored report artifacts."""

import re


_SENSITIVE = re.compile(
    r"(?i)(?:password|passwd|passphrase|api[_ -]?key|access[_ -]?token|"
    r"refresh[_ -]?token|token|secret|private[_ -]?key|credential|"
    r"ciphertext|encrypted|wrapped[_ -]?dek|bearer\s+\S+|"
    r"-----BEGIN\s+[^\r\n]*PRIVATE KEY-----)"
)


def safe_text(value) -> str:
    if value is None:
        return ""
    raw = str(getattr(value, "value", value))
    return "[redacted]" if _SENSITIVE.search(raw) else raw


def csv_cell(value) -> str:
    value = safe_text(value)
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) else value
