import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeviceLivePanel from "../../components/DeviceLivePanel";
import { useDeviceLive } from "../useDeviceLive";

class FakeSocket {
  static all: FakeSocket[] = [];
  url: string;
  protocols: string[];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.all.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const FRAME = {
  cpu_percent: 37.5,
  ram_percent: 61.2,
  ram_used_mb: 9800,
  ram_total_mb: 16000,
  disks: [{ mount: "C:", used_percent: 71, free_gb: 68.4, total_gb: 237.9 }],
  net_rx_kbps: 820.4,
  net_tx_kbps: 95.1,
  uptime_seconds: 90000,
  current_user: "TECHI\\mario",
  process_count: 212,
  processes: [{ pid: 4321, name: "sqlservr.exe", cpu_percent: 22, memory_mb: 4100 }],
};

function Harness({ deviceId, enabled }: { deviceId: number; enabled: boolean }) {
  const live = useDeviceLive(deviceId, enabled);
  return <DeviceLivePanel live={live} />;
}

describe("useDeviceLive", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens the device's live socket and shows the agent's frames", () => {
    render(<Harness deviceId={924} enabled />);
    const socket = FakeSocket.all[0];
    expect(socket.url).toMatch(/\/ws\/devices\/924\/live$/);
    expect(socket.protocols).toEqual(["techi.v1"]);

    act(() => socket.emit({ type: "live_status", agent_connected: true, interval_seconds: 3 }));
    expect(screen.getByText("Waiting for the agent…")).toBeInTheDocument();

    act(() => socket.emit({ type: "live", device_id: 924, data: FRAME }));
    expect(screen.getByText("Live · every 3 s")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("mario")).toBeInTheDocument();
    expect(screen.getByText("sqlservr.exe")).toBeInTheDocument();
    expect(screen.getByText("68.4 GB free of 238 GB")).toBeInTheDocument();
  });

  it("says when the agent has no live channel", () => {
    render(<Harness deviceId={924} enabled />);
    act(() => FakeSocket.all[0].emit({ type: "live_status", agent_connected: false, interval_seconds: 3 }));
    expect(screen.getByText(/older than 2\.1\.27/)).toBeInTheDocument();
  });

  it("opens nothing when disabled and closes the socket when it turns off", () => {
    const { rerender } = render(<Harness deviceId={924} enabled={false} />);
    expect(FakeSocket.all).toHaveLength(0);

    rerender(<Harness deviceId={924} enabled />);
    expect(FakeSocket.all).toHaveLength(1);

    rerender(<Harness deviceId={924} enabled={false} />);
    expect(FakeSocket.all[0].closed).toBe(true);
  });

  it("stops while the browser tab is hidden", () => {
    render(<Harness deviceId={924} enabled />);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeSocket.all[0].closed).toBe(true);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeSocket.all).toHaveLength(2);
    visibility.mockRestore();
  });

  it("does not retry a refused socket", () => {
    vi.useFakeTimers();
    render(<Harness deviceId={924} enabled />);
    act(() => FakeSocket.all[0].onclose?.({ code: 4001 }));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSocket.all).toHaveLength(1);
    expect(screen.getByText("Live view unavailable")).toBeInTheDocument();
  });

  it("dims the numbers when frames stop arriving", () => {
    vi.useFakeTimers();
    render(<Harness deviceId={924} enabled />);
    const socket = FakeSocket.all[0];
    act(() => socket.emit({ type: "live_status", agent_connected: true, interval_seconds: 3 }));
    act(() => socket.emit({ type: "live", device_id: 924, data: FRAME }));
    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(screen.getByText("Waiting for the agent…")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
  });
});

describe("DeviceLivePanel without a stream", () => {
  const idle = { state: "agent_offline" as const, snapshot: null, receivedAt: null, intervalSeconds: 3 };
  const heartbeat = {
    cpu_percent: 41,
    ram_percent: 63,
    disk_percent: 72,
    uptime_seconds: 7200,
    current_user: "TECHI\\laura",
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
  };

  it("shows the last heartbeat's values in the same place, labelled with their age", () => {
    render(<DeviceLivePanel live={idle} fallback={heartbeat} />);
    expect(screen.getByText("Latest")).toBeInTheDocument();
    expect(screen.getByText(/From the last heartbeat · 4m ago/)).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
    expect(screen.getByText("72% used")).toBeInTheDocument();
    expect(screen.getByText("laura")).toBeInTheDocument();
    // A heartbeat carries no network rate: no empty tile for it.
    expect(screen.queryByText("Network")).toBeNull();
  });

  it("says when a device has no live view at all", () => {
    render(<DeviceLivePanel live={idle} fallback={heartbeat} liveCapable={false} />);
    expect(screen.getByText("Live view not available for this device")).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
  });
});
