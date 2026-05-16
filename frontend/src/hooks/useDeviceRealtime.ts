import { useEffect, useRef, useState } from "react";
import {
  DeviceRealtimeClient,
  DeviceRealtimeDiagnostics,
  DeviceRealtimeEvent,
  DeviceRealtimeStatus,
} from "../services/deviceRealtime";

interface UseDeviceRealtimeOptions {
  enabled?: boolean;
  tenantId?: string;
  onEvent: (event: DeviceRealtimeEvent) => void;
  onStatusChange?: (status: DeviceRealtimeStatus, diagnostics: DeviceRealtimeDiagnostics) => void;
}

export function useDeviceRealtime({
  enabled = true,
  tenantId = "default",
  onEvent,
  onStatusChange,
}: UseDeviceRealtimeOptions): DeviceRealtimeStatus {
  const [status, setStatus] = useState<DeviceRealtimeStatus>("connecting");
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (!enabled) {
      setStatus("disconnected");
      return;
    }

    const client = new DeviceRealtimeClient(tenantId);
    const removeEventHandler = client.onEvent((event) => onEventRef.current(event));
    const removeStatusHandler = client.onStatus((nextStatus, diagnostics) => {
      setStatus(nextStatus);
      onStatusChangeRef.current?.(nextStatus, diagnostics);
    });
    const connectTimer = window.setTimeout(() => client.connect(), 0);

    return () => {
      window.clearTimeout(connectTimer);
      removeEventHandler();
      removeStatusHandler();
      client.disconnect();
    };
  }, [enabled, tenantId]);

  return status;
}
