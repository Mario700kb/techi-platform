import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearToasts, toast } from "../../services/toast";
import Toaster from "../Toaster";

describe("Toaster", () => {
  afterEach(() => act(() => clearToasts()));

  it("shows what just happened, errors as alerts, and an action that closes it", () => {
    render(<Toaster />);
    const undo = vi.fn();
    act(() => {
      toast("Agent update queued for 4 devices", { action: { label: "Undo", onClick: undo } });
      toast.error("Connect failed");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Agent update queued for 4 devices");
    expect(screen.getByRole("alert")).toHaveTextContent("Connect failed");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText("Agent update queued for 4 devices")).not.toBeInTheDocument();
  });

  it("closes when its time runs out or on Dismiss", () => {
    const { container } = render(<Toaster />);
    act(() => {
      toast("Saved");
      toast.info("Opening the Remote Support app instead");
    });
    // jsdom has no AnimationEvent, so React listens for the prefixed name there.
    const timeBar = container.querySelector(".th-toaster-time")!;
    fireEvent.animationEnd(timeBar);
    fireEvent(timeBar, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not stack the same message, and keeps at most four", () => {
    render(<Toaster />);
    act(() => {
      toast("Copied");
      toast("Copied");
      for (let i = 1; i <= 5; i++) toast(`Queued ${i}`);
    });
    expect(screen.queryByText("Copied")).not.toBeInTheDocument(); // the oldest went first
    expect(screen.getAllByRole("status")).toHaveLength(4);
    expect(screen.getByText("Queued 5")).toBeInTheDocument();
  });
});
