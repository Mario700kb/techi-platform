import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DatePicker from "../DatePicker";

function Harness({
  initial = "",
  onValue = () => undefined,
  ...props
}: Partial<Parameters<typeof DatePicker>[0]> & {
  initial?: string;
  onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <label>
      From
      <DatePicker
        {...props}
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    </label>
  );
}

const open = () => fireEvent.click(screen.getByRole("button", { name: /From/ }));
const day = (label: RegExp) => screen.getByRole("button", { name: label });

describe("DatePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 12 Oct 2026 10:30 in Tirana (UTC+2).
    vi.setSystemTime(new Date("2026-10-12T08:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows the placeholder, opens on today's month with Monday first, and picks a day", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    expect(screen.getByText("Select date")).toBeInTheDocument();

    open();
    const dialog = screen.getByRole("dialog", { name: "Choose date" });
    expect(dialog).toHaveTextContent("October 2026");
    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("Mo");
    expect(day(/Monday, 12 October 2026/)).toHaveAttribute("aria-current", "date");

    fireEvent.click(day(/Thursday, 15 October 2026/));
    expect(onValue).toHaveBeenLastCalledWith("2026-10-15");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /From/ })).toHaveTextContent("15 Oct 2026");
  });

  it("moves with the keyboard and picks with Enter", () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-10-15" onValue={onValue} />);
    open();
    expect(day(/15 October 2026/)).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(day(/22 October 2026/)).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "PageDown" });
    expect(screen.getByRole("dialog")).toHaveTextContent("November 2026");
    expect(day(/22 November 2026/)).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(onValue).toHaveBeenLastCalledWith("2026-11-22");
  });

  it("closes on Escape without changing the value", () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-10-15" onValue={onValue} />);
    open();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();
  });

  it("disables days outside min and max", () => {
    render(<Harness min="2026-10-10" max="2026-10-20" />);
    open();
    expect(day(/, 9 October 2026$/)).toBeDisabled();
    expect(day(/10 October 2026/)).toBeEnabled();
    expect(day(/21 October 2026/)).toBeDisabled();
  });

  it("clears and picks today", () => {
    const onValue = vi.fn();
    render(<Harness initial="2026-10-15" onValue={onValue} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onValue).toHaveBeenLastCalledWith("");
    expect(screen.getByText("Select date")).toBeInTheDocument();

    open();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onValue).toHaveBeenLastCalledWith("2026-10-12");
  });

  it("jumps through the month and year view", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Choose month and year" }));
    fireEvent.click(screen.getByRole("button", { name: "Next year" }));
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("March 2027");
    fireEvent.click(day(/, 5 March 2027$/));
    expect(onValue).toHaveBeenLastCalledWith("2027-03-05");
  });

  describe("with time", () => {
    it("uses the default time, edits hour and minute, and Now is the Tirana clock", () => {
      const onValue = vi.fn();
      render(<Harness withTime defaultTime="23:59" onValue={onValue} />);
      expect(screen.getByText("Select date and time")).toBeInTheDocument();
      open();
      expect(screen.getByRole("textbox", { name: "Hour" })).toBeDisabled();

      fireEvent.click(day(/20 October 2026/));
      expect(onValue).toHaveBeenLastCalledWith("2026-10-20T23:59");
      expect(screen.getByRole("dialog")).toBeInTheDocument(); // stays open to set the time

      fireEvent.change(screen.getByRole("textbox", { name: "Hour" }), { target: { value: "09" } });
      expect(onValue).toHaveBeenLastCalledWith("2026-10-20T09:59");
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Minute" }), { key: "ArrowUp" });
      expect(onValue).toHaveBeenLastCalledWith("2026-10-20T09:00");

      fireEvent.click(screen.getByRole("button", { name: "Now" }));
      expect(onValue).toHaveBeenLastCalledWith("2026-10-12T10:30");
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /From/ })).toHaveTextContent("12 Oct 2026, 10:30");
    });
  });
});
