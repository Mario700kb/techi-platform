import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnimatedNumber from "../../components/ui/AnimatedNumber";
import { FLASH_MS, motion } from "../../utils/motion";
import { useFlashOnChange, useNewKeys } from "../useLiveChange";

describe("live changes", () => {
  beforeEach(() => {
    motion.enabled = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    motion.enabled = false;
    vi.useRealTimers();
  });

  it("highlights a value when it changes, not when it first shows", () => {
    const { result, rerender } = renderHook(({ value }) => useFlashOnChange(value), {
      initialProps: { value: "online" },
    });
    expect(result.current).toBe(false);
    rerender({ value: "offline" });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(FLASH_MS));
    expect(result.current).toBe(false);
  });

  it("marks rows that arrive live, but not a first load, a page or a filter", () => {
    const { result, rerender } = renderHook(({ keys }) => useNewKeys(keys), { initialProps: { keys: [1, 2, 3] } });
    expect(result.current.size).toBe(0);

    rerender({ keys: [4, 1, 2, 3] });
    expect([...result.current]).toEqual([4]);

    // The list changes again before the highlight ends: it still ends.
    rerender({ keys: [4, 1, 2] });
    act(() => vi.advanceTimersByTime(FLASH_MS));
    expect(result.current.size).toBe(0);

    rerender({ keys: [10, 11, 12, 13, 14] }); // next page
    expect(result.current.size).toBe(0);
    rerender({ keys: [20] }); // a filter with one row, none kept
    expect(result.current.size).toBe(0);
  });

  it("counts to a new figure instead of jumping", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { rerender } = render(<AnimatedNumber value={10} />);
    expect(screen.getByText("10")).toBeInTheDocument();

    rerender(<AnimatedNumber value={110} />);
    act(() => frames.shift()!(325)); // halfway in time, past halfway in value (ease out)
    const midway = Number(screen.getByText(/^\d+$/).textContent);
    expect(midway).toBeGreaterThan(60);
    expect(midway).toBeLessThan(110);
    expect(screen.getByText(/^\d+$/)).toHaveAttribute("data-changed", "true");

    act(() => frames.shift()!(1000));
    expect(screen.getByText("110")).toBeInTheDocument();
  });

  it("shows the final figure at once when motion is off", () => {
    motion.enabled = false;
    const { rerender } = render(<AnimatedNumber value={1} />);
    rerender(<AnimatedNumber value={937} format={(n) => `${n} PCs`} />);
    expect(screen.getByText("937 PCs")).not.toHaveAttribute("data-changed");
  });
});
