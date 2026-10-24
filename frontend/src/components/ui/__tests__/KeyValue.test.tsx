import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Kv from "../KeyValue";

describe("Kv copy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies a text value and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <dl>
        <Kv label="MAC address" mono copy>
          00:15:5d:01:02:03
        </Kv>
      </dl>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy MAC address" }));
    });
    expect(writeText).toHaveBeenCalledWith("00:15:5d:01:02:03");
    expect(screen.getByRole("button", { name: "MAC address copied" })).toBeTruthy();
  });

  it("offers nothing to copy for an empty value or without copy", () => {
    render(
      <dl>
        <Kv label="MAC address" copy>
          {null}
        </Kv>
        <Kv label="Local IP">10.5.50.99</Kv>
      </dl>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
