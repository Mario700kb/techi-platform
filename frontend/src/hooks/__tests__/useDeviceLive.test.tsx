import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeviceLivePanel, { HeartbeatValues } from "../../components/DeviceLivePanel";
import { appCache } from "../../store/appCache";
import { cachedLiveFrame, LIVE_CACHE_KEY, rememberLiveFrame } from "../../store/liveCache";
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

function Harness({
  deviceId,
  enabled,
  fallback = null,
}: {
  deviceId: number;
  enabled: boolean;
  fallback?: HeartbeatValues | null;
}) {
  const live = useDeviceLive(deviceId, enabled);
  return <DeviceLivePanel live={live} fallback={fallback} />;
}

const status = () => screen.getByTestId("live-status").textContent;
const panelMode = () => screen.getByRole("region", { name: "Live" }).getAttribute("data-live-mode");
const panelSource = () => screen.getByRole("region", { name: "Live" }).getAttribute("data-live-source");

describe("useDeviceLive", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    appCache.invalidate();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    appCache.invalidate();
  });

  it("opens the device's live socket and shows the agent's frames", () => {
    render(<Harness deviceId={924} enabled />);
    const socket = FakeSocket.all[0];
    expect(socket.url).toMatch(/\/ws\/devices\/924\/live$/);
    expect(socket.protocols).toEqual(["techi.v1"]);

    act(() => socket.emit({ type: "live_status", agent_connected: true, interval_seconds: 3 }));
    expect(status()).toBe("Connecting…");

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
    expect(status()).toBe("Paused");
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

  it("keeps the last values, dimmed and paused, when frames stop arriving", () => {
    vi.useFakeTimers();
    render(<Harness deviceId={924} enabled />);
    const socket = FakeSocket.all[0];
    act(() => socket.emit({ type: "live_status", agent_connected: true, interval_seconds: 3 }));
    act(() => socket.emit({ type: "live", device_id: 924, data: FRAME }));
    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(status()).toMatch(/^Paused · last at \d{2}:\d{2}$/);
    expect(panelMode()).toBe("paused");
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("sqlservr.exe")).toBeInTheDocument();
  });

  it("never unmounts the tiles when the stream ends: the same nodes keep the last values", () => {
    vi.useFakeTimers();
    render(<Harness deviceId={924} enabled />);
    const socket = FakeSocket.all[0];
    act(() => socket.emit({ type: "live", device_id: 924, data: FRAME }));
    const cpuTile = screen.getByTestId("live-tile-CPU");
    const table = screen.getByRole("table");

    act(() => socket.onclose?.({ code: 1006 }));
    expect(status()).toMatch(/^Paused · last at/);
    expect(screen.getByTestId("live-tile-CPU")).toBe(cpuTile);
    expect(screen.getByRole("table")).toBe(table);
    expect(cpuTile).toHaveTextContent("38%");

    // The reconnect's first frame updates the same nodes in place.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => FakeSocket.all[1].emit({ type: "live", device_id: 924, data: { ...FRAME, cpu_percent: 64 } }));
    expect(status()).toBe("Live · every 3 s");
    expect(screen.getByTestId("live-tile-CPU")).toBe(cpuTile);
    expect(cpuTile).toHaveTextContent("64%");
  });

  it("keeps the values, paused, when the drawer stops the subscription", () => {
    const { rerender } = render(<Harness deviceId={924} enabled />);
    act(() => FakeSocket.all[0].emit({ type: "live", device_id: 924, data: FRAME }));
    const cpuTile = screen.getByTestId("live-tile-CPU");

    rerender(<Harness deviceId={924} enabled={false} />);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(status()).toMatch(/^Paused · last at/);
    expect(screen.getByTestId("live-tile-CPU")).toBe(cpuTile);
    expect(cpuTile).toHaveTextContent("38%");
  });

  describe("seeding: this session's last frame, else the heartbeat, else skeletons", () => {
    const heartbeat: HeartbeatValues = {
      cpu_percent: 41,
      ram_percent: 63,
      disk_percent: 72,
      uptime_seconds: 7200,
      current_user: "TECHI\\laura",
      at: new Date(Date.now() - 2 * 60_000).toISOString(),
    };

    it("1. paints the cached frame at once, labelled with its age, before any socket answers", () => {
      rememberLiveFrame(924, FRAME, Date.now() - 2 * 60_000);
      render(<Harness deviceId={924} enabled fallback={heartbeat} />);
      expect(panelSource()).toBe("live");
      expect(screen.getByText("38%")).toBeInTheDocument();
      expect(screen.getByText("sqlservr.exe")).toBeInTheDocument();
      expect(screen.queryByText("41%")).toBeNull();
      expect(status()).toBe("From 2m ago · connecting…");
      expect(panelMode()).toBe("starting");
    });

    it("2. falls back to the heartbeat when this session has no frame for the device", () => {
      rememberLiveFrame(925, FRAME); // another device's frame is not used
      render(<Harness deviceId={924} enabled fallback={heartbeat} />);
      expect(panelSource()).toBe("heartbeat");
      expect(screen.getByText("41%")).toBeInTheDocument();
      expect(screen.getByText("72% used")).toBeInTheDocument();
      expect(status()).toBe("From 2m ago · connecting…");
    });

    it("3. shows skeleton tiles only when nothing is known", () => {
      render(<Harness deviceId={924} enabled />);
      expect(panelSource()).toBe("none");
      expect(status()).toBe("Connecting…");
      // The same four tiles, waiting: nothing moves when values arrive.
      expect(screen.getAllByTestId(/^live-tile-/)).toHaveLength(4);
      expect(screen.queryByText("38%")).toBeNull();
      act(() => FakeSocket.all[0].emit({ type: "live", device_id: 924, data: FRAME }));
      expect(screen.getAllByTestId(/^live-tile-/)).toHaveLength(4);
      expect(screen.getByText("38%")).toBeInTheDocument();
    });

    it("ignores a cached frame older than 15 minutes", () => {
      rememberLiveFrame(924, FRAME, Date.now() - 16 * 60_000);
      render(<Harness deviceId={924} enabled fallback={heartbeat} />);
      expect(panelSource()).toBe("heartbeat");
      expect(screen.getByText("41%")).toBeInTheDocument();
    });

    it("remembers each frame, and a device shown again starts from it", () => {
      const { unmount } = render(<Harness deviceId={924} enabled />);
      act(() => FakeSocket.all[0].emit({ type: "live", device_id: 924, data: FRAME }));
      expect(cachedLiveFrame(924)?.snapshot.cpu_percent).toBe(37.5);
      unmount();

      render(<Harness deviceId={924} enabled />);
      expect(screen.getByText("38%")).toBeInTheDocument();
      expect(status()).toMatch(/^From .+ · connecting…$/);
    });

    it("switches devices without showing one device's values on another", () => {
      rememberLiveFrame(924, FRAME);
      const { rerender } = render(<Harness deviceId={924} enabled />);
      expect(screen.getByText("38%")).toBeInTheDocument();
      rerender(<Harness deviceId={925} enabled />);
      expect(screen.queryByText("38%")).toBeNull();
      expect(FakeSocket.all[0].closed).toBe(true);
      // A late frame on the old socket is dropped.
      act(() => FakeSocket.all[0].emit({ type: "live", device_id: 924, data: FRAME }));
      expect(screen.queryByText("38%")).toBeNull();
    });
  });
});

describe("liveCache", () => {
  afterEach(() => {
    appCache.invalidate();
    appCache.setScope("");
    window.sessionStorage.clear();
  });

  it("keeps the 20 most recent devices and persists them per operator", () => {
    appCache.setScope("7");
    const now = Date.now();
    for (let id = 1; id <= 25; id++) rememberLiveFrame(id, { cpu_percent: id }, now - (25 - id) * 1000);
    const kept = appCache.peek<Record<string, unknown>>(LIVE_CACHE_KEY) ?? {};
    expect(Object.keys(kept)).toHaveLength(20);
    expect(cachedLiveFrame(1)).toBeNull();
    expect(cachedLiveFrame(25)?.snapshot.cpu_percent).toBe(25);
    expect(Object.keys(window.sessionStorage).some((k) => k.includes(`:7:${LIVE_CACHE_KEY}`))).toBe(true);

    appCache.setScope(""); // a reload: memory starts empty
    appCache.setScope("7");
    expect(cachedLiveFrame(25)?.snapshot.cpu_percent).toBe(25);
    appCache.setScope("8");
    expect(cachedLiveFrame(25)).toBeNull();
  });
});

describe("DeviceLivePanel without a stream", () => {
  const idle = { state: "agent_offline" as const, snapshot: null, receivedAt: null, intervalSeconds: 3, active: true };
  const heartbeat = {
    cpu_percent: 41,
    ram_percent: 63,
    disk_percent: 72,
    uptime_seconds: 7200,
    current_user: "TECHI\\laura",
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
  };

  it("shows the last heartbeat's values in the same tiles, paused, when the agent has no live channel", () => {
    render(<DeviceLivePanel live={idle} fallback={heartbeat} />);
    expect(status()).toMatch(/^Paused · last at \d{2}:\d{2}$/);
    expect(screen.getByText(/older than 2\.1\.27/)).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
    expect(screen.getByText("72% used")).toBeInTheDocument();
    expect(screen.getByText("laura")).toBeInTheDocument();
    // The same four tiles as live: a heartbeat has no network rate, so a dash.
    expect(screen.getAllByTestId(/^live-tile-/)).toHaveLength(4);
    expect(screen.getByTestId("live-tile-Network")).toHaveTextContent("↓ —");
  });

  it("lists the inventory's processes by memory when the heartbeat is all there is", () => {
    render(
      <DeviceLivePanel
        live={idle}
        fallback={{
          ...heartbeat,
          processes: [
            { pid: 1, name: "small.exe", memory_mb: 10 },
            { pid: 2, name: "big.exe", memory_mb: 2048 },
          ],
        }}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("big.exe—2.0 GB");
    expect(screen.getByText("From the inventory · by memory")).toBeInTheDocument();
  });

  it("shows the top 5 processes and toggles all 10", () => {
    const processes = Array.from({ length: 10 }, (_, i) => ({
      pid: i,
      name: `p${i}.exe`,
      cpu_percent: 10 - i,
      memory_mb: 100,
    }));
    render(
      <DeviceLivePanel
        live={{
          state: "live",
          snapshot: { cpu_percent: 5, processes },
          receivedAt: Date.now(),
          intervalSeconds: 3,
          active: true,
        }}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(1 + 5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10" }));
    expect(screen.getAllByRole("row")).toHaveLength(1 + 10);
    fireEvent.click(screen.getByRole("button", { name: "Show top 5" }));
    expect(screen.getAllByRole("row")).toHaveLength(1 + 5);
  });

  it("says when a device has no live view at all", () => {
    render(<DeviceLivePanel live={idle} fallback={heartbeat} liveCapable={false} />);
    expect(screen.getByText("Latest")).toBeInTheDocument();
    expect(status()).toBe("From the last heartbeat · 4m ago");
    expect(screen.getByText("Live view not available for this device.")).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
  });
});
