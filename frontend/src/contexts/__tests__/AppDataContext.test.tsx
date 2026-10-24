import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as devicesApi from "../../api/devices";
import type { DeviceFleetOverview } from "../../api/devices";
import type { DeviceRealtimeEvent, DeviceRealtimeStatus } from "../../services/deviceRealtime";
import { AppDataProvider, useAppData } from "../AppDataContext";

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner", username: "owner" } }),
}));

let socketStatus: DeviceRealtimeStatus = "connecting";
let emitEvent: ((event: DeviceRealtimeEvent) => void) | undefined;
vi.mock("../../hooks/useDeviceRealtime", () => ({
  useDeviceRealtime: (options: { onEvent?: (event: DeviceRealtimeEvent) => void }) => {
    emitEvent = options.onEvent;
    return socketStatus;
  },
}));

const reloadAlerts = vi.fn();
vi.mock("../../hooks/useAlerts", () => ({
  useAlerts: () => ({ alerts: [], alertCount: { total_open: 0 }, alertCountReady: true, reload: reloadAlerts }),
  alertCountCacheKey: (userId: number) => `techi.alerts.count.v1:${userId}`,
}));

const overview = {
  stats: { total: 1, online: 1, stale: 0, offline: 0 },
  tree_counts: { by_client: {}, by_client_category: {}, unassigned: 0 },
} as unknown as DeviceFleetOverview;

function renderProvider() {
  return render(
    <AppDataProvider>
      <span />
    </AppDataProvider>,
  );
}

describe("AppDataProvider keeps the fleet overview current", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.sessionStorage.clear();
    reloadAlerts.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("polls the overview every 30 s while there is no socket", async () => {
    socketStatus = "fallback";
    const getOverview = vi.spyOn(devicesApi, "getDevicesOverview").mockResolvedValue(overview);

    renderProvider();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getOverview).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(getOverview).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(getOverview).toHaveBeenCalledTimes(3);
  });

  it("keeps polling while the socket cycles through its retries", async () => {
    socketStatus = "connecting";
    const getOverview = vi.spyOn(devicesApi, "getDevicesOverview").mockResolvedValue(overview);

    const view = renderProvider();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getOverview).toHaveBeenCalledTimes(1);

    // A retry every 5 s: connecting → fallback → connecting …
    for (let i = 0; i < 7; i += 1) {
      socketStatus = i % 2 ? "connecting" : "fallback";
      view.rerender(
        <AppDataProvider>
          <span />
        </AppDataProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(5_000));
    }
    expect(getOverview).toHaveBeenCalledTimes(2);
  });

  it("does not poll with the socket connected, and catches up when it reconnects", async () => {
    socketStatus = "connected";
    const getOverview = vi.spyOn(devicesApi, "getDevicesOverview").mockResolvedValue(overview);

    const view = renderProvider();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(getOverview).toHaveBeenCalledTimes(1);

    socketStatus = "disconnected";
    view.rerender(
      <AppDataProvider>
        <span />
      </AppDataProvider>,
    );
    socketStatus = "connected";
    view.rerender(
      <AppDataProvider>
        <span />
      </AppDataProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Forced past the 30 s freshness window: events were missed while down.
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(reloadAlerts).toHaveBeenCalledTimes(1);
  });
});

describe("AppDataProvider hands every realtime event to the screens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function Recorder({ seen }: { seen: string[] }) {
    const { latestEvent } = useAppData();
    useEffect(() => {
      if (latestEvent) seen.push(`${latestEvent.type}:${String(latestEvent.data?.agent_version ?? "")}`);
    }, [latestEvent, seen]);
    return null;
  }

  it("delivers a heartbeat's burst of events one at a time, none lost", async () => {
    socketStatus = "connected";
    vi.spyOn(devicesApi, "getDevicesOverview").mockResolvedValue(overview);
    const seen: string[] = [];
    render(
      <AppDataProvider>
        <Recorder seen={seen} />
      </AppDataProvider>,
    );
    const event = (type: string, data: Record<string, unknown>) =>
      ({ event_id: type, version: 1, type, tenant_id: "default", occurred_at: "", data }) as unknown as DeviceRealtimeEvent;

    // All four arrive before React renders, as they do after a heartbeat.
    act(() => {
      emitEvent?.(event("heartbeat_received", { id: 7, agent_version: "2.1.40" }));
      emitEvent?.(event("device_updated", { id: 7, agent_version: "2.1.40" }));
      emitEvent?.(event("telemetry_updated", { id: 7 }));
      emitEvent?.(event("patch_status_updated", { id: 7 }));
    });
    await act(async () => {});

    expect(seen).toEqual([
      "heartbeat_received:2.1.40",
      "device_updated:2.1.40",
      "telemetry_updated:",
      "patch_status_updated:",
    ]);
  });
});
