import { act, renderHook, waitFor } from "@testing-library/react";
import * as alertsApi from "../../api/alerts";
import { alertCountCacheKey, useAlerts } from "../useAlerts";
import type { Alert, AlertCount } from "../../types/alert";
import type { DeviceRealtimeEvent } from "../../services/deviceRealtime";

const COUNT: AlertCount = {
  total_open: 3,
  by_severity: { critical: 2, warning: 1 },
  by_kind: { device_offline: 2, low_disk: 1 },
  devices_affected: 3,
};

function alert(id: number, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    device_id: 7,
    kind: "device_offline",
    severity: "critical",
    state: "open",
    message: `alert ${id}`,
    created_at: "2026-10-13T10:00:00",
    updated_at: "2026-10-13T10:00:00",
    ...overrides,
  };
}

describe("useAlerts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("shows the counts as soon as they arrive, without waiting for the feed", async () => {
    vi.spyOn(alertsApi, "getAlertCount").mockResolvedValue(COUNT);
    vi.spyOn(alertsApi, "getAlerts").mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAlerts({ cacheKey: alertCountCacheKey(1) }));

    expect(result.current.alertCountReady).toBe(false);
    await waitFor(() => expect(result.current.alertCountReady).toBe(true));
    expect(result.current.alertCount.by_kind).toEqual(COUNT.by_kind);
  });

  it("paints the last counts at once after a reload, then refreshes them", async () => {
    window.sessionStorage.setItem(alertCountCacheKey(1), JSON.stringify(COUNT));
    vi.spyOn(alertsApi, "getAlertCount").mockResolvedValue({ ...COUNT, total_open: 4 });
    vi.spyOn(alertsApi, "getAlerts").mockResolvedValue([]);
    const { result } = renderHook(() => useAlerts({ cacheKey: alertCountCacheKey(1) }));

    expect(result.current.alertCountReady).toBe(true);
    expect(result.current.alertCount.total_open).toBe(3);
    await waitFor(() => expect(result.current.alertCount.total_open).toBe(4));
  });

  it("moves the per-kind counts with realtime alerts, not only on the next poll", async () => {
    vi.spyOn(alertsApi, "getAlertCount").mockResolvedValue(COUNT);
    vi.spyOn(alertsApi, "getAlerts").mockResolvedValue([]);
    const { result, rerender } = renderHook(({ event }) => useAlerts({ latestEvent: event }), {
      initialProps: { event: null as DeviceRealtimeEvent | null },
    });
    await waitFor(() => expect(result.current.alertCountReady).toBe(true));

    const created = { type: "alert_created", data: alert(91, { kind: "low_disk", severity: "warning" }) };
    act(() => rerender({ event: created as unknown as DeviceRealtimeEvent }));
    expect(result.current.alertCount.by_kind).toEqual({ device_offline: 2, low_disk: 2 });

    const resolved = { type: "alert_resolved", data: alert(11) };
    act(() => rerender({ event: resolved as unknown as DeviceRealtimeEvent }));
    expect(result.current.alertCount.by_kind).toEqual({ device_offline: 1, low_disk: 2 });
    expect(result.current.alertCount.total_open).toBe(3);
  });

  it("forgets cached counts when the operator signs out", async () => {
    window.sessionStorage.setItem(alertCountCacheKey(1), JSON.stringify(COUNT));
    renderHook(() => useAlerts({ enabled: false }));
    expect(window.sessionStorage.getItem(alertCountCacheKey(1))).toBeNull();
  });
});
