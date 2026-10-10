import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TopbarClock from "../TopbarClock";

describe("TopbarClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T14:44:00Z")); // 16:44 CEST in Tirana
  });
  afterEach(() => vi.useRealTimers());

  it("shows Tirana time and keeps ticking", () => {
    render(<TopbarClock />);
    expect(screen.getByText("16:44")).toBeInTheDocument();
    expect(screen.getByText("Mon 5 Oct")).toBeInTheDocument();
    expect(screen.getByText("Tirana")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(61_000); });
    expect(screen.getByText("16:45")).toBeInTheDocument();
  });
});
