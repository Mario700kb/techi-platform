import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Device } from "../../api/devices";
import DeviceIdentityCard from "../DeviceIdentityCard";

const DEVICE = {
  id: 7,
  hostname: "HV-PROD-01",
  platform: "windows",
  os_caption: "Microsoft Windows Server 2025 Standard Evaluation",
  os_build: "10.0.26100",
  current_user: "Administrator",
  user_source: "console_session",
  user_session_state: "active",
  domain: "WORKGROUP",
  cpu: "Intel64 Family 6 Model 85 Stepping 7, GenuineIntel",
  ram: "63 GB",
  storage: "85 GB free / 930 GB total",
  capabilities: { powershell: "" },
} as unknown as Device;

describe("DeviceIdentityCard", () => {
  it("lists user, OS, domain and platform as key/value pairs and the hardware as three mini-stats", () => {
    render(<DeviceIdentityCard device={DEVICE} linux />);
    const card = screen.getByRole("region", { name: "Identity" });
    expect(card).toHaveTextContent("AdministratorConsole· Session: active");
    expect(card).toHaveTextContent("Windows Server 2025 Standard Evaluation· Build 26100");
    expect(within(card).getByText("WORKGROUP")).toBeInTheDocument();

    const hw = within(card).getByLabelText("Hardware");
    const cpu = within(hw).getByText("Intel · Skylake-SP / Cascade Lake (Xeon)").closest("dd");
    expect(cpu).toHaveAttribute("title", expect.stringContaining("Intel64 Family 6 Model 85 Stepping 7"));
    expect(within(hw).getByText("63 GB")).toBeInTheDocument();
    expect(within(hw).getByText("85 GB free of 930 GB")).toBeInTheDocument();
    expect(within(hw).getByRole("img", { name: "91% used" })).toHaveAttribute("data-tone", "critical");
    expect(within(card).getByText("powershell")).toBeInTheDocument();
  });

  it("prefers the live user and hides capabilities without Linux support", () => {
    render(<DeviceIdentityCard device={DEVICE} liveUser={"TECHI\\denis"} linux={false} />);
    expect(screen.getByText("TECHI\\denis")).toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).toBeNull();
  });
});
