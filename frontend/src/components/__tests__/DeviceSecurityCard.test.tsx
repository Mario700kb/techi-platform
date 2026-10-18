import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeviceInventory, SecurityPosture } from "../../api/inventory";
import DeviceSecurityCard from "../DeviceSecurityCard";

const POSTURE: SecurityPosture = {
  collected_at: "2026-10-17T16:00:00Z",
  defender: { present: true, antivirus_enabled: true, realtime_enabled: true, signature_age_days: 1 },
  third_party_av: [],
  firewall: { domain: true, private: true, public: false },
  bitlocker: { system_drive: "C:", protection: "on", encryption_percent: 100 },
  uac_enabled: true,
  secure_boot: null,
  local_admins: ["MARIO-LENOVO\\Administrator", "TECHI\\Domain Admins", "MARIO-LENOVO\\mario"],
};

function inventory(posture: SecurityPosture | null): DeviceInventory {
  return {
    device_id: 924,
    processes: [],
    services: [],
    software: [],
    reboot_required: false,
    patch_state: "up_to_date",
    security_posture: posture,
    security_collected_at: posture ? "2026-10-17T16:00:00Z" : null,
  };
}

function fact(label: string) {
  const grid = screen.getByLabelText("Security posture");
  return within(grid).getByText(label).parentElement as HTMLElement;
}

describe("DeviceSecurityCard", () => {
  it("shows the posture as a grid of facts", () => {
    render(
      <DeviceSecurityCard
        agentVersion="2.1.31"
        inventory={inventory(POSTURE)}
        loading={false}
        error={null}
        onLoad={() => {}}
      />,
    );
    expect(fact("Antivirus")).toHaveTextContent("Defender");
    expect(fact("Antivirus")).toHaveTextContent("Real-time on · signatures 1 d old");
    expect(fact("Firewall")).toHaveTextContent("Off: Public");
    expect(fact("BitLocker C:")).toHaveTextContent("On");
    expect(fact("BitLocker C:")).toHaveTextContent("100% encrypted");
    expect(fact("UAC")).toHaveTextContent("On");
    expect(fact("Secure Boot")).toHaveTextContent("Unknown");
    expect(fact("Local admins")).toHaveTextContent("3");
    expect(fact("Local admins")).toHaveAttribute(
      "title",
      "MARIO-LENOVO\\Administrator\nTECHI\\Domain Admins\nMARIO-LENOVO\\mario",
    );
    expect(screen.getByText(/^Collected /)).toBeInTheDocument();
  });

  it("names a third-party antivirus and flags no antivirus at all", () => {
    const { rerender } = render(
      <DeviceSecurityCard
        agentVersion="2.1.31"
        inventory={inventory({
          ...POSTURE,
          defender: { ...POSTURE.defender, antivirus_enabled: false },
          third_party_av: ["ESET Security"],
        })}
        loading={false}
        error={null}
        onLoad={() => {}}
      />,
    );
    expect(fact("Antivirus")).toHaveTextContent("ESET Security");
    rerender(
      <DeviceSecurityCard
        agentVersion="2.1.31"
        inventory={inventory({
          ...POSTURE,
          defender: { present: false, antivirus_enabled: null, realtime_enabled: null, signature_age_days: null },
        })}
        loading={false}
        error={null}
        onLoad={() => {}}
      />,
    );
    expect(fact("Antivirus")).toHaveTextContent("None active");
  });

  it("says which agent is needed on an older device, without loading anything", () => {
    const onLoad = vi.fn();
    render(<DeviceSecurityCard agentVersion="2.1.20" inventory={null} loading={false} error={null} onLoad={onLoad} />);
    expect(screen.getByText(/Needs agent 2\.1\.31/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers to load the inventory on a current agent", () => {
    const onLoad = vi.fn();
    const { rerender } = render(
      <DeviceSecurityCard agentVersion="2.1.31" inventory={null} loading={false} error={null} onLoad={onLoad} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show security/ }));
    expect(onLoad).toHaveBeenCalledOnce();
    rerender(
      <DeviceSecurityCard
        agentVersion="2.1.31"
        inventory={inventory(null)}
        loading={false}
        error={null}
        onLoad={onLoad}
      />,
    );
    expect(screen.getByText(/Not reported yet/)).toBeInTheDocument();
  });
});
