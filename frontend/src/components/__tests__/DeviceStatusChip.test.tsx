import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceStatusChip } from "../DeviceStatusChip";

const NOW = new Date("2026-10-18T12:30:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

const chip = () => screen.getByTestId("device-status");

describe("DeviceStatusChip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns stale and then offline on the shared clock, with no new props", () => {
    // Last heartbeat 5m50s ago: online for another 10 s.
    render(<DeviceStatusChip device={{ status: "online", last_seen: ago(5 * MIN + 50_000) }} />);
    expect(chip()).toHaveTextContent("Online·5m ago");
    expect(chip()).toHaveAttribute("data-state", "online");

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(chip()).toHaveTextContent("Stale·6m ago");
    expect(chip()).toHaveAttribute("data-state", "stale");

    act(() => {
      vi.advanceTimersByTime(19 * MIN + 15_000);
    });
    expect(chip()).toHaveTextContent("Offline·No heartbeat · since 14:24");
    expect(chip()).toHaveAttribute("data-state", "offline");
  });

  it("shows a live device without an age, its dot breathing", () => {
    render(<DeviceStatusChip device={{ status: "online", live: true, last_seen: ago(4 * MIN) }} />);
    expect(chip()).toHaveTextContent("Online·live");
    expect(chip().querySelector(".th-devstatus-dot")).toHaveAttribute("data-live", "true");
    // Still live minutes later: no event, no ageing.
    act(() => {
      vi.advanceTimersByTime(10 * MIN);
    });
    expect(chip()).toHaveTextContent("Online·live");
  });

  it("shows a dropped live connection as reconnecting, with a hollow dot", () => {
    render(
      <DeviceStatusChip device={{ status: "online", live: false, live_lost_at: ago(5000), last_seen: ago(MIN) }} />,
    );
    expect(chip()).toHaveTextContent("Online·reconnecting…");
    expect(chip().querySelector(".th-devstatus-dot")).toHaveAttribute("data-reconnecting", "true");
    expect(chip()).toHaveAttribute("title", expect.stringMatching(/waiting for it to return/));
  });

  it("stacks the same words for table rows, with an inferred hint", () => {
    render(
      <DeviceStatusChip
        layout="stacked"
        device={{ status: "offline", offline_reason: "shutdown", last_seen: ago(25 * MIN) }}
        hint={{ label: "Site?" }}
      />,
    );
    expect(chip()).toHaveTextContent("OfflineShut down · since 14:05 · Site?");
  });
});
