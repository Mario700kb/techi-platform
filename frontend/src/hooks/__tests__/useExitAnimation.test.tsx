import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exitAnimations, useExitAnimation } from "../useExitAnimation";

function Menu() {
  const ref = useExitAnimation<HTMLDivElement>();
  return (
    <div ref={ref} id="menu" className="th-menu" role="menu">
      <button type="button">Rename</button>
    </div>
  );
}

let show: (value: boolean) => void = () => undefined;
function Host() {
  const [open, setOpen] = useState(true);
  show = setOpen;
  return <div data-testid="host">{open && <Menu />}</div>;
}

describe("useExitAnimation", () => {
  beforeEach(() => {
    exitAnimations.enabled = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    exitAnimations.enabled = false;
    vi.useRealTimers();
  });

  it("leaves an inert copy that animates out and removes itself", async () => {
    const { getByTestId } = render(<Host />);
    await act(async () => show(false));

    const ghost = getByTestId("host").querySelector(".th-leaving");
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    expect(ghost).toHaveAttribute("inert");
    expect(ghost).not.toHaveAttribute("id");
    expect(getByTestId("host").querySelectorAll('[role="menu"]')).toHaveLength(1);

    act(() => vi.advanceTimersByTime(400));
    expect(getByTestId("host").querySelector(".th-leaving")).toBeNull();
  });

  it("leaves nothing when the element stays", async () => {
    const { getByTestId, rerender } = render(<Host />);
    await act(async () => rerender(<Host />));
    expect(getByTestId("host").querySelector(".th-leaving")).toBeNull();
  });

  it("does nothing when exit animations are off (reduced motion, unit tests)", async () => {
    exitAnimations.enabled = false;
    const { getByTestId } = render(<Host />);
    await act(async () => show(false));
    expect(getByTestId("host").querySelector(".th-leaving")).toBeNull();
  });
});
