"""List settings accept JSON and comma-separated values from the environment."""
import pytest

from app.core.config import Settings


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("owner,admin", ["owner", "admin"]),
        (" Owner , ADMIN ", ["owner", "admin"]),
        ('["owner","admin"]', ["owner", "admin"]),
        ("", []),
    ],
)
def test_mfa_required_roles(monkeypatch, raw, expected):
    monkeypatch.setenv("DEV_ALLOW_RANDOM_SECRET", "true")
    monkeypatch.setenv("MFA_REQUIRED_ROLES", raw)
    assert Settings().MFA_REQUIRED_ROLES == expected


@pytest.mark.parametrize(
    "raw",
    ['["https://rdp.techi.com.al"]', "https://rdp.techi.com.al", "https://rdp.techi.com.al, "],
)
def test_cors_origins_production_and_comma_forms(monkeypatch, raw):
    monkeypatch.setenv("DEV_ALLOW_RANDOM_SECRET", "true")
    monkeypatch.setenv("BACKEND_CORS_ORIGINS", raw)
    assert Settings().BACKEND_CORS_ORIGINS == ["https://rdp.techi.com.al"]
