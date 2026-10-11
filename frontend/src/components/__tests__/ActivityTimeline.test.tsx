import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActivityTimeline from "../ActivityTimeline";

describe("ActivityTimeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T15:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows relative time with the absolute Tirana time as a tooltip", () => {
    render(
      <ActivityTimeline
        loading={false}
        events={[{ id: "1", type: "maintenance_entered", occurred_at: "2026-10-05T14:00:00", summary: "Maintenance started", device_id: 7 }]}
      />,
    );
    const time = screen.getByText("1h ago");
    expect(time).toHaveAttribute("title", "5 Oct 2026, 16:00");
  });

  it("uses the shared empty state", () => {
    render(<ActivityTimeline loading={false} events={[]} />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });
});
