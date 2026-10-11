import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppPreloader from "../AppPreloader";

describe("AppPreloader", () => {
  it("is announced as a status and shows the brand", () => {
    render(<AppPreloader />);
    const status = screen.getByRole("status", { name: "Loading TECHI Connect" });
    expect(status).toHaveClass("th-preloader");
    expect(status.querySelector(".th-preloader__mark")).toHaveAttribute("src", "/brand/techi-mark.svg");
    expect(screen.getByText("TECHI Connect")).toBeInTheDocument();
  });

  it("continues the boot screen's animation instead of restarting it", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(2100);
    render(<AppPreloader />);
    const stack = document.querySelector<HTMLElement>(".th-preloader__stack")!;
    const bar = document.querySelector<HTMLElement>(".th-preloader__bar")!;
    // Fade-in long finished (150ms after load), bar 700ms into its 1400ms cycle.
    expect(stack.style.animationDelay).toBe("-1950ms");
    expect(bar.style.animationDelay).toBe("-700ms");
    now.mockRestore();
  });

  it("inline variant is the bar alone, fading in after a short delay", () => {
    render(<AppPreloader inline label="Loading session" />);
    const status = screen.getByRole("status", { name: "Loading session" });
    expect(status).toHaveClass("th-preloader--inline");
    expect(status.querySelector(".th-preloader__mark")).toBeNull();
    expect(document.querySelector<HTMLElement>(".th-preloader__stack")!.style.animationDelay).toBe("150ms");
  });
});
