from app.models.device import DeviceType
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.trusted_domain_service import TrustedDomainService


def test_windows_10_product_type_1_is_client_pc():
    assert (
        DeviceHeartbeatService.classify_device_type(
            "windows",
            "corp.local",
            os_caption="Microsoft Windows 10 Pro",
            windows_product_type=1,
        )
        == DeviceType.CLIENT
    )
    assert (
        TrustedDomainService.detect_group_name(
            "windows",
            "windows",
            os_caption="Microsoft Windows 10 Pro",
            windows_product_type=1,
        )
        == "Client PC"
    )


def test_windows_11_product_type_1_is_client_pc():
    assert (
        DeviceHeartbeatService.classify_device_type(
            "windows",
            "corp.local",
            os_caption="Microsoft Windows 11 Pro",
            windows_product_type=1,
        )
        == DeviceType.CLIENT
    )


def test_windows_server_2019_product_type_3_is_server():
    assert (
        DeviceHeartbeatService.classify_device_type(
            "windows",
            "corp.local",
            os_caption="Microsoft Windows Server 2019 Standard",
            os_build="10.0.17763",
            windows_product_type=3,
        )
        == DeviceType.SERVER
    )
    assert (
        TrustedDomainService.detect_group_name(
            "windows",
            "windows",
            os_caption="Microsoft Windows Server 2019 Standard",
            windows_product_type=3,
        )
        == "Servers"
    )


def test_windows_server_2022_product_type_3_is_server():
    assert (
        DeviceHeartbeatService.classify_device_type(
            "windows",
            "corp.local",
            os_caption="Microsoft Windows Server 2022 Standard",
            windows_product_type=3,
        )
        == DeviceType.SERVER
    )


def test_domain_controller_product_type_2_is_server():
    assert (
        DeviceHeartbeatService.classify_device_type(
            "windows",
            "corp.local",
            os_caption="Microsoft Windows Server 2019 Standard",
            os_build="10.0.17763",
            windows_product_type=2,
        )
        == DeviceType.SERVER
    )
    assert (
        TrustedDomainService.detect_group_name(
            "windows",
            "windows",
            os_caption="Microsoft Windows Server 2019 Standard",
            windows_product_type=2,
        )
        == "Servers"
    )


def test_server_caption_fallback_is_server():
    assert (
        DeviceHeartbeatService.classify_device_type(
            "windows",
            "corp.local",
            os_caption="Microsoft Windows Server 2019 Standard",
        )
        == DeviceType.SERVER
    )
