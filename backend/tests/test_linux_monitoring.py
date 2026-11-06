"""Agent 2.1.48 on Linux reports the same things as Windows, in the same shape."""
from datetime import datetime, timezone

from app.schemas.device_health import ALERTING_REBOOT_REASONS, DeviceHealth
from app.schemas.security_posture import SecurityPosture
from app.services.alert_rules import EVENT_GROUP_OF, EVENT_GROUPS
from app.services.client_reports.security import evaluate
from app.services.security_posture import posture_findings, posture_score

LINUX = {
    "platform": "linux", "defender": {"present": False}, "third_party_av": [],
    "firewall": {"domain": None, "private": None, "public": True},
    "bitlocker": {"system_drive": "/", "protection": "on"},
    "uac_enabled": None, "secure_boot": None, "local_admins": ["root"],
}


def test_a_protected_linux_machine_scores_full_without_an_antivirus():
    assert posture_findings(LINUX) == []
    assert posture_score(LINUX) == 100
    score, issues, values = evaluate(LINUX)
    assert score == 100 and issues == [] and values["protected"] is True and values["firewall"] == "On"


def test_a_windows_machine_without_an_antivirus_still_counts():
    windows = {**LINUX, "platform": None, "bitlocker": {"system_drive": "C:", "protection": "on"},
               "firewall": {"domain": True, "private": True, "public": True}}
    assert ("no_antivirus", "No active antivirus") in posture_findings(windows)
    assert any(check == "antivirus" for _, check, _ in evaluate(windows)[1])


def test_linux_problems_read_in_linux_words_and_keep_the_system_disk():
    bad = {**LINUX, "firewall": {"public": False}, "bitlocker": {"system_drive": "/", "protection": "off"},
           "secure_boot": False}
    assert SecurityPosture.model_validate(bad).bitlocker.system_drive == "/"
    assert [text for _, text in posture_findings(bad)] == ["Firewall off", "Disk encryption is off", "Secure Boot is off"]
    # Everything wrong a Linux machine can show stays above the alert line (70).
    assert posture_score(bad) == 70
    score, issues, values = evaluate(bad)
    assert {text for _, _, text in issues} == {"Firewall off", "Disk encryption off", "Secure Boot off"}
    assert values["firewall"] == "Off" and score == 65


def test_linux_events_and_a_pending_restart_are_understood():
    now = datetime.now(timezone.utc).isoformat()
    health = DeviceHealth.model_validate({
        "reboot_pending": True, "reboot_reasons": ["package_update"],
        "events": [
            {"record_id": 1, "source": "linux-kernel", "event_id": 3, "at": now},
            {"record_id": 2, "source": "linux-kernel", "event_id": 5, "at": now},
            {"record_id": 3, "source": "linux-boot", "event_id": 1, "at": now},
            {"record_id": 4, "source": "systemd", "event_id": 1, "at": now},
            {"record_id": 5, "source": "linux-kernel", "event_id": 99, "at": now},
        ],
    })
    assert health.reboot_reasons == ["package_update"] and "package_update" in ALERTING_REBOOT_REASONS
    assert [e.title for e in health.events] == [
        "Disk I/O error", "Out of memory: a process was killed", "Restarted without a clean shutdown",
        "Service stopped unexpectedly",
    ]


def test_every_alerting_linux_event_belongs_to_a_group():
    for key, group in EVENT_GROUP_OF.items():
        assert group in EVENT_GROUPS, key
    for key in (("linux-kernel", 1), ("linux-kernel", 2), ("linux-kernel", 3), ("linux-kernel", 4),
                ("linux-kernel", 5), ("linux-boot", 1)):
        assert key in EVENT_GROUP_OF
