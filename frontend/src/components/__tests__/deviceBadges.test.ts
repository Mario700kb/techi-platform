import { describe, expect, it } from "vitest";

import type { Device } from "../../api/devices";
import type { DeviceHealthSummary } from "../../types/telemetry";
import { TONE } from "../../utils/deviceStatus";
import { agentVersionView, healthTone, offlineReasonBadge, remoteSupportIssue } from "../../utils/deviceBadges";

const device = (overrides: Partial<Device> = {}) => ({ id: 1, hostname: "d1", ...overrides }) as Device;
const health = (score: number, state: DeviceHealthSummary["health_state"]) =>
  ({ health_score: score, health_state: state }) as DeviceHealthSummary;

describe("shared device badges", () => {
  it("colours health by the server's health_state, not the score", () => {
    expect(healthTone(health(55, "healthy"))).toBe("good");
    expect(healthTone(health(90, "critical"))).toBe("critical");
    expect(healthTone(undefined)).toBe("none");
  });

  it("falls back to Stale as the likely cause for a stale device", () => {
    const stale = device({ freshness_state: "stale", last_seen: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(offlineReasonBadge(stale)).toEqual({ label: "Stale", tone: TONE.stale });
  });

  it("names a stopped Remote Support service in full", () => {
    const d = device({
      freshness_state: "offline",
      last_seen: "2026-10-10T10:00:00",
      rustdesk_status: "stopped",
      rustdesk_install_status: "installed",
    });
    expect(offlineReasonBadge(d)?.label).toBe("Remote Support stopped");
    expect(remoteSupportIssue(d)?.label).toBe("Remote off");
    expect(remoteSupportIssue(d)?.title).toBe("Remote Support: Stopped");
    expect(remoteSupportIssue(device({ rustdesk_status: "running" }))).toBeNull();
    expect(remoteSupportIssue(device({ rustdesk_status: undefined }))).toBeNull();
  });

  it("measures a non-Windows agent against its own platform's version", () => {
    const linux = device({ platform: "linux", architecture: "x86_64", agent_version: "2.1.21" });
    const view = agentVersionView(linux, {
      activePackageVersion: "2.1.20",
      activeAgentVersions: { "linux:x86_64": "2.1.21" },
    });
    expect(view).toEqual({ status: "current", title: "Latest: 2.1.21" });
  });
});
