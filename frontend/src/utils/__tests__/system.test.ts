import { describe, expect, it } from "vitest";

import { cpuView, osView, storageView } from "../system";

describe("osView", () => {
  it("names the Windows release from the build", () => {
    expect(osView({ os_caption: "Microsoft Windows 11 Pro", os_build: "10.0.26200" })).toEqual({
      name: "Windows 11 Pro",
      detail: "25H2 · build 26200",
    });
    expect(osView({ os_caption: "Microsoft Windows 10 Pro", os_build: "10.0.19045" }).detail).toBe(
      "22H2 · build 19045",
    );
    expect(osView({ os_caption: "Microsoft Windows 10 Enterprise LTSC", os_build: "10.0.17763" }).detail).toBe(
      "1809 · build 17763",
    );
  });

  it("keeps server names whole and shows an unknown build as is", () => {
    expect(osView({ os_caption: "Microsoft Windows Server 2019 Standard", os_build: "10.0.17763" })).toEqual({
      name: "Windows Server 2019 Standard",
      detail: "Build 17763",
    });
    expect(osView({ os_caption: "Microsoft Windows 11 Pro", os_build: "10.0.26300" }).detail).toBe("Build 26300");
  });

  it("falls back for other platforms", () => {
    expect(osView({ os_caption: "Ubuntu 24.04.1 LTS", os_name: "linux" })).toEqual({
      name: "Ubuntu 24.04.1 LTS",
      detail: null,
    });
    expect(osView({ os_caption: "Board=RB4011; Version=7.15", os_name: "RouterOS" }).name).toBe("RouterOS");
  });
});

describe("cpuView", () => {
  it("decodes the microarchitecture from PROCESSOR_IDENTIFIER", () => {
    expect(cpuView("Intel64 Family 6 Model 85 Stepping 4, GenuineIntel")).toEqual({
      name: "Intel · Skylake-SP / Cascade Lake (Xeon)",
      raw: "Intel64 Family 6 Model 85 Stepping 4, GenuineIntel",
    });
    expect(cpuView("AMD64 Family 25 Model 33 Stepping 0, AuthenticAMD")?.name).toBe("AMD · Zen 3 / Zen 4");
    expect(cpuView("Intel64 Family 6 Model 250 Stepping 1, GenuineIntel")?.name).toBe("Intel · family 6, model 250");
  });

  it("keeps a real CPU name as it is", () => {
    expect(cpuView("Intel(R) Core(TM) i5-8400 CPU @ 2.80GHz")).toEqual({
      name: "Intel(R) Core(TM) i5-8400 CPU @ 2.80GHz",
      raw: null,
    });
    expect(cpuView("")).toBeNull();
  });
});

describe("storageView", () => {
  it("reads free and total and works out the share used", () => {
    expect(storageView("76 GB free / 149 GB total")).toEqual({ totalGb: 149, freeGb: 76, usedPct: 49 });
    expect(storageView("1 TB")).toBeNull();
  });
});
