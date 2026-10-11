import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { timeAgo } from "../../utils/time";
import { useNow } from "../useNow";

function LastSeen({ iso }: { iso: string }) {
  useNow();
  return <span>{timeAgo(iso)}</span>;
}

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-renders relative labels on its own, without new props", () => {
    render(<LastSeen iso="2026-10-11T11:58:00Z" />);
    expect(screen.getByText("2m ago")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(screen.getByText("7m ago")).toBeInTheDocument();
  });

  it("stops ticking once nothing subscribes", () => {
    const { unmount } = render(<LastSeen iso="2026-10-11T11:58:00Z" />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
