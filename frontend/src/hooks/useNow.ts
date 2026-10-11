import { useSyncExternalStore } from "react";

// One shared clock for every relative label ("5m ago", "Fresh"). Those labels
// are computed at render time, and with the WebSocket connected nothing else
// re-renders a quiet page, so without a tick a device that stops reporting
// keeps reading "Fresh". A single interval serves all subscribers and stops
// when the last one unmounts.
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((notify) => notify());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot() {
  return now;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
