import { getDeviceActions } from "../api/actions";
import { prefetchQuery } from "../hooks/useCachedQuery";

/** The drawer's action history, the one query it makes as it opens. */
export const deviceActionsKey = (deviceId: number) => `page.device.${deviceId}.actions`;

const HOVER_DELAY_MS = 150;
let hoverTimer: number | undefined;

/**
 * A mouse resting on a device row for a moment loads what its drawer asks for
 * first, so a click opens it filled. Passing over rows on the way elsewhere
 * loads nothing.
 */
export function prefetchDeviceOnHover(deviceId: number, pointerType: string): void {
  if (pointerType !== "mouse") return;
  window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(
    () => prefetchQuery(deviceActionsKey(deviceId), () => getDeviceActions(deviceId)),
    HOVER_DELAY_MS,
  );
}

export function cancelDevicePrefetch(): void {
  window.clearTimeout(hoverTimer);
}
