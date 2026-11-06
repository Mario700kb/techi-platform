import { describe, expect, it } from "vitest";

import { formatBitsAxis, formatBytesRateAxis, formatMemoryMB } from "../monitoring";

describe("chart axis labels", () => {
  it("keep their first digit: they fit the eight characters the axis has room for", () => {
    expect(formatBytesRateAxis(10_000_000)).toBe("10 MB/s");
    expect(formatBytesRateAxis(5_000_000)).toBe("5 MB/s");
    expect(formatBytesRateAxis(2_500_000)).toBe("2.5 MB/s");
    expect(formatBitsAxis(60_000_000)).toBe("60 Mb/s");
    expect(formatBitsAxis(0)).toBe("0");
    for (const scale of [1, 1e3, 1e6, 1e9]) {
      for (const value of [1, 2.5, 9.9, 10, 25, 99.5, 100, 500, 999]) {
        expect(formatBytesRateAxis(value * scale).length).toBeLessThanOrEqual(8);
        expect(formatBitsAxis(value * scale).length).toBeLessThanOrEqual(8);
      }
    }
  });

  it("memory reads in MB, then GB", () => {
    expect(formatMemoryMB(512)).toBe("512 MB");
    expect(formatMemoryMB(2048)).toBe("2.0 GB");
    expect(formatMemoryMB(null)).toBe("—");
  });
});
