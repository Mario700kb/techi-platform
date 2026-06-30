from app.api.v1.endpoints.remote_support import _build_connect_url


def test_connect_url_includes_encoded_managed_password(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEEP_LINK_PASSWORD_ENABLED",
        True,
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEFAULT_PASSWORD",
        "Durres.12!",
    )

    assert _build_connect_url("294 938 618") == (
        "techiremotesupport://294%20938%20618?password=Durres.12%21"
    )


def test_connect_url_omits_password_when_feature_disabled(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEEP_LINK_PASSWORD_ENABLED",
        False,
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEFAULT_PASSWORD",
        "Durres.12",
    )

    assert _build_connect_url("294938618") == "techiremotesupport://294938618"


def test_connect_url_omits_blank_password(monkeypatch):
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEEP_LINK_PASSWORD_ENABLED",
        True,
    )
    monkeypatch.setattr(
        "app.api.v1.endpoints.remote_support.settings.RUSTDESK_DEFAULT_PASSWORD",
        "   ",
    )

    assert _build_connect_url("294938618") == "techiremotesupport://294938618"
