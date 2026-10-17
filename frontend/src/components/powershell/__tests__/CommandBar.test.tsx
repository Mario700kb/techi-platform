import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CommandBar, { toConsoleInput } from "../CommandBar";

function setup(history: string[] = [], disabled = false) {
  const onRun = vi.fn();
  const onInterrupt = vi.fn();
  render(<CommandBar history={history} disabled={disabled} onRun={onRun} onInterrupt={onInterrupt} />);
  const input = screen.getByLabelText("Command") as HTMLTextAreaElement;
  return { input, onRun, onInterrupt };
}

function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value } });
  input.selectionStart = input.selectionEnd = value.length;
}

describe("CommandBar", () => {
  it("runs on Enter and clears", () => {
    const { input, onRun } = setup();
    type(input, "Get-Service spooler");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith("Get-Service spooler");
    expect(input.value).toBe("");
  });

  it("runs from the Run button and ignores blank input", () => {
    const { input, onRun } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Run/ })).toBeDisabled();
    type(input, "hostname");
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect(onRun).toHaveBeenCalledWith("hostname");
  });

  it("leaves Shift+Enter to the textarea (a new line)", () => {
    const { input, onRun } = setup();
    type(input, "Get-Date");
    const event = fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(event).toBe(true); // not prevented: the browser inserts the newline
    expect(onRun).not.toHaveBeenCalled();
    type(input, "Get-Date\nhostname");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledWith("Get-Date\nhostname");
  });

  it("walks this session's commands with ↑ and ↓ and keeps the draft", () => {
    const { input } = setup(["ipconfig", "whoami"]);
    type(input, "Get-");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("whoami");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("ipconfig");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("ipconfig");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("whoami");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("Get-");
  });

  it("does not take ↑ from inside a multi-line command", () => {
    const { input } = setup(["ipconfig"]);
    type(input, "line one\nline two");
    const event = fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(event).toBe(true);
    expect(input.value).toBe("line one\nline two");
  });

  it("sends Ctrl+C as an interrupt unless text is selected", () => {
    const { input, onInterrupt } = setup();
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    type(input, "some text");
    input.selectionStart = 0;
    input.selectionEnd = 4;
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("is inert while the session is not open", () => {
    const { input, onInterrupt } = setup([], true);
    expect(input).toBeDisabled();
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("turns lines into carriage returns for the console", () => {
    expect(toConsoleInput("hostname")).toBe("hostname\r");
    expect(toConsoleInput("a\nb\r\nc")).toBe("a\rb\rc\r");
  });
});
