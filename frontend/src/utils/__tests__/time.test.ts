import { describe, expect, it } from "vitest";
import { formatLocalDateTime, tiranaInputToUtcIso, utcToTiranaInput } from "../time";

describe("Tirana time helpers", () => {
  it("reads form input as Tirana wall-clock time, in summer and winter", () => {
    expect(tiranaInputToUtcIso("2026-10-05T16:44")).toBe("2026-10-05T14:44:00.000Z"); // CEST
    expect(tiranaInputToUtcIso("2026-12-01T08:00")).toBe("2026-12-01T07:00:00.000Z"); // CET
    expect(tiranaInputToUtcIso("2026-09-01")).toBe("2026-08-31T22:00:00.000Z");
  });

  it("prefills inputs with Tirana time and round-trips", () => {
    expect(utcToTiranaInput("2026-10-05T14:44:00")).toBe("2026-10-05T16:44");
    expect(utcToTiranaInput("2026-12-01T07:00:00Z")).toBe("2026-12-01T08:00");
    expect(tiranaInputToUtcIso(utcToTiranaInput("2026-10-05T14:44:00Z"))).toBe("2026-10-05T14:44:00.000Z");
    expect(utcToTiranaInput(null)).toBe("");
  });

  it("displays API (naive UTC) times in Tirana time", () => {
    expect(formatLocalDateTime("2026-10-05T14:44:00", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })).toBe("16:44");
  });
});

describe("every displayed date uses Tirana time", () => {
  // Every source file under src/ (tests excluded), as raw text.
  const sources = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../**/__tests__/**"], {
    query: "?raw",
    import: "default",
    eager: true,
  });

  it("passes timeZone: APP_TIME_ZONE to every toLocale*String on a Date", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const re = /\.toLocale(Date|Time)?String\(/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        if (/\btotal$/.test(before)) continue; // number formatting
        const call = text.slice(m.index, m.index + 200).split("\n").slice(0, 3).join("\n");
        if (!call.includes("timeZone: APP_TIME_ZONE")) offenders.push(`${file}: ${call.split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
