import { act, renderHook, waitFor } from "@testing-library/react";
import * as alertsApi from "../../api/alerts";
import { useDeviceAlerts } from "../useDeviceAlerts";
import type { Alert } from "../../types/alert";
import type { DeviceRealtimeEvent } from "../../services/deviceRealtime";

function alert(id: number, overrides: Partial<Alert> = {}): Alert {
  return {
    id,
    device_id: 7,
    kind: "device_offline",
    severity: "critical",
    state: "resolved",
    message: `alert ${id}`,
    created_at: "2026-10-09T10:00:00",
    updated_at: "2026-10-09T10:00:00",
    resolved_at: "2026-10-09T11:00:00",
    ...overrides,
  };
}

describe("useDeviceAlerts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("lists resolved alerts by when they were resolved, newest first", async () => {
    vi.spyOn(alertsApi, "getDeviceAlerts").mockImplementation(async (_id, state) =>
      state === "open"
        ? []
        : [
            alert(1, { created_at: "2026-10-09T14:59:33", resolved_at: "2026-10-11T00:15:00" }),
            alert(2, { created_at: "2026-10-10T08:00:00", resolved_at: "2026-10-10T08:05:00" }),
            alert(3, { created_at: "2026-10-08T09:00:00", resolved_at: "2026-10-12T09:00:00" }),
          ],
    );
    const { result } = renderHook(() => useDeviceAlerts({ deviceId: 7 }));
    await waitFor(() => expect(result.current.resolvedAlerts).toHaveLength(3));
    expect(result.current.resolvedAlerts.map((a) => a.id)).toEqual([3, 1, 2]);
  });

  it("moves an alert from open to the top of resolved on a realtime event", async () => {
    vi.spyOn(alertsApi, "getDeviceAlerts").mockImplementation(async (_id, state) =>
      state === "open" ? [alert(9, { state: "open", resolved_at: null })] : [alert(1)],
    );
    let event: DeviceRealtimeEvent | null = null;
    const { result, rerender } = renderHook(() => useDeviceAlerts({ deviceId: 7, latestEvent: event }));
    await waitFor(() => expect(result.current.openAlerts).toHaveLength(1));

    event = {
      type: "alert_resolved",
      data: alert(9, { resolved_at: "2026-10-12T12:00:00" }) as unknown as Record<string, unknown>,
    } as DeviceRealtimeEvent;
    rerender();
    expect(result.current.openAlerts).toHaveLength(0);
    expect(result.current.resolvedAlerts.map((a) => a.id)).toEqual([9, 1]);
  });

  it("re-reads the lists every minute as a backstop for missed events", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const spy = vi.spyOn(alertsApi, "getDeviceAlerts").mockResolvedValue([]);
    renderHook(() => useDeviceAlerts({ deviceId: 7 }));
    await act(async () => {});
    expect(spy).toHaveBeenCalledTimes(2); // open + resolved
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
