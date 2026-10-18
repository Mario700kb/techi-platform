import { afterEach, describe, expect, it } from "vitest";

import {
  deviceFreshness,
  isReconnecting,
  noteServerTime,
  ONLINE_WINDOW_MS,
  presenceView,
  resetServerClock,
  serverNow,
  STALE_WINDOW_MS,
} from "../devicePresence";

// 18 Oct 2026 14:30 in Tirana (UTC+2 until 25 Oct).
const NOW = Date.parse("2026-10-18T12:30:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe("deviceFreshness — the backend's freshness_for, in the browser", () => {
  it("moves a heartbeat device online → stale → offline exactly at the window edges", () => {
    const at = (age: number) => deviceFreshness({ status: "online", last_seen: ago(age) }, NOW);
    expect(at(0)).toBe("online");
    expect(at(ONLINE_WINDOW_MS)).toBe("online");
    expect(at(ONLINE_WINDOW_MS + 1)).toBe("stale");
    expect(at(STALE_WINDOW_MS)).toBe("stale");
    expect(at(STALE_WINDOW_MS + 1)).toBe("offline");
  });

  it("keeps a known offline device offline until a heartbeat or the channel says otherwise", () => {
    for (const reason of ["shutdown", "sleep", "connection_lost"]) {
      expect(deviceFreshness({ status: "offline", offline_reason: reason, last_seen: ago(MIN) }, NOW)).toBe("offline");
    }
    // The heartbeat's event: status online, the reason cleared.
    expect(deviceFreshness({ status: "online", offline_reason: null, last_seen: ago(0) }, NOW)).toBe("online");
    // A timeout offline still ages through the windows, as on the server.
    expect(deviceFreshness({ status: "offline", offline_reason: null, last_seen: ago(MIN) }, NOW)).toBe("online");
  });

  it("counts a live device online whatever its last heartbeat, but not over a known offline", () => {
    expect(deviceFreshness({ status: "online", live: true, last_seen: ago(3 * 60 * MIN) }, NOW)).toBe("online");
    expect(deviceFreshness({ status: "offline", offline_reason: "sleep", live: true, last_seen: ago(0) }, NOW)).toBe(
      "offline",
    );
  });

  it("uses the server's word only when there is no last_seen field at all", () => {
    expect(deviceFreshness({ freshness_state: "stale" }, NOW)).toBe("stale");
    expect(deviceFreshness({ freshness_state: "online", last_seen: null }, NOW)).toBe("offline");
  });
});

describe("server clock", () => {
  afterEach(() => resetServerClock());

  it("ages rows against the server's clock, not a browser that runs fast", () => {
    const browser = Date.now();
    // The server is two minutes behind this browser.
    noteServerTime(new Date(browser - 2 * MIN).toISOString(), browser);
    expect(Math.round((serverNow() - Date.now()) / MIN)).toBe(-2);
    // Network delay only lowers a sample: the largest recent one wins.
    noteServerTime(new Date(browser - 2 * MIN - 800).toISOString(), browser);
    expect(Math.round((serverNow() - Date.now()) / 1000)).toBe(-120);
  });
});

describe("presenceView — the chip's words", () => {
  const text = (v: { label: string; detail: string }) => (v.detail ? `${v.label} · ${v.detail}` : v.label);

  it("says live for a device with its channel open, with no age", () => {
    const view = presenceView({ status: "online", live: true, last_seen: ago(4 * MIN) }, NOW);
    expect(text(view)).toBe("Online · live");
    expect(view.live).toBe(true);
  });

  it("gives a heartbeat device its age", () => {
    expect(text(presenceView({ status: "online", last_seen: ago(20_000) }, NOW))).toBe("Online · just now");
    expect(text(presenceView({ status: "online", last_seen: ago(2 * MIN + 5000) }, NOW))).toBe("Online · 2m ago");
    expect(text(presenceView({ status: "online", last_seen: ago(9 * MIN) }, NOW))).toBe("Stale · 9m ago");
  });

  it("names why and since when a device is offline", () => {
    const since = ago(25 * MIN); // 14:05 Tirana
    expect(text(presenceView({ status: "offline", offline_reason: "shutdown", last_seen: since }, NOW))).toBe(
      "Offline · Shut down · since 14:05",
    );
    expect(text(presenceView({ status: "offline", offline_reason: "sleep", last_seen: since }, NOW))).toBe(
      "Offline · Asleep · since 14:05",
    );
    expect(text(presenceView({ status: "offline", offline_reason: "connection_lost", last_seen: since }, NOW))).toBe(
      "Offline · Connection lost · since 14:05",
    );
    expect(text(presenceView({ status: "offline", last_seen: ago(40 * MIN) }, NOW))).toBe(
      "Offline · No heartbeat · since 13:50",
    );
    // Not today: how long ago instead of a clock time.
    expect(text(presenceView({ status: "offline", last_seen: ago(26 * 60 * MIN) }, NOW))).toBe(
      "Offline · No heartbeat · 1d ago",
    );
    expect(text(presenceView({ status: "offline", last_seen: null }, NOW))).toBe("Offline · Never seen");
  });

  it("says reconnecting while a dropped live channel has its grace, and stops after it", () => {
    const device = { status: "online", live: false, live_lost_at: ago(20_000), last_seen: ago(2 * MIN) };
    const view = presenceView(device, NOW);
    expect(text(view)).toBe("Online · reconnecting…");
    expect(view.reconnecting).toBe(true);
    expect(view.title).toMatch(/dropped at 14:29:40/);
    // A missed end-of-grace event does not leave it reconnecting forever.
    expect(isReconnecting({ ...device, live_lost_at: ago(4 * MIN) }, NOW)).toBe(false);
    // Once offline, the offline words win.
    expect(isReconnecting({ ...device, status: "offline", offline_reason: "connection_lost" }, NOW)).toBe(false);
  });
});
