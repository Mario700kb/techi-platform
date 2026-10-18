import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DeviceLivePanel, { type HeartbeatValues } from "../DeviceLivePanel";
import type { DeviceLive } from "../../hooks/useDeviceLive";

const MIN = 60_000;
const heartbeat = (cpu: number, ago: number): HeartbeatValues => ({
  cpu_percent: cpu,
  ram_percent: 40,
  disk_percent: 50,
  uptime_seconds: 3600,
  current_user: "user",
  at: new Date(Date.now() - ago).toISOString(),
});
const live = (state: DeviceLive["state"], cpu: number, ago: number): DeviceLive => ({
  state,
  snapshot: { cpu_percent: cpu, ram_percent: 40, disks: [], processes: [] } as unknown as DeviceLive["snapshot"],
  receivedAt: Date.now() - ago,
  intervalSeconds: 3,
  active: true,
});

describe("the Live tiles' starting values", () => {
  it("show a heartbeat newer than the cached frame while connecting", () => {
    render(<DeviceLivePanel live={live("connecting", 11, 10 * MIN)} fallback={heartbeat(42, MIN)} />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.queryByText("11%")).not.toBeInTheDocument();
  });

  it("keep a cached frame newer than the heartbeat", () => {
    render(<DeviceLivePanel live={live("connecting", 11, MIN)} fallback={heartbeat(42, 4 * MIN)} />);
    expect(screen.getByText("11%")).toBeInTheDocument();
  });

  it("follow the stream once it is live, whatever the heartbeat says", () => {
    render(<DeviceLivePanel live={live("live", 11, 20 * MIN)} fallback={heartbeat(42, MIN)} />);
    expect(screen.getByText("11%")).toBeInTheDocument();
  });
});
