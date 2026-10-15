// Readable OS and hardware from what the agent reports: the OS caption and
// build, and the raw CPU identifier (PROCESSOR_IDENTIFIER), RAM and storage
// strings.
import type { Device } from "../api/devices";

// Windows feature updates by build number (the third part of 10.0.x).
const WINDOWS_10_RELEASES: Record<number, string> = {
  10240: "1507",
  10586: "1511",
  14393: "1607",
  15063: "1703",
  16299: "1709",
  17134: "1803",
  17763: "1809",
  18362: "1903",
  18363: "1909",
  19041: "2004",
  19042: "20H2",
  19043: "21H1",
  19044: "21H2",
  19045: "22H2",
};
const WINDOWS_11_RELEASES: Record<number, string> = {
  22000: "21H2",
  22621: "22H2",
  22631: "23H2",
  26100: "24H2",
  26200: "25H2",
};

export interface OsView {
  /** "Windows 11 Pro", "Windows Server 2019 Standard", "Ubuntu 24.04 LTS". */
  name: string;
  /** "25H2 · build 26200", or the build alone when the release is not known. */
  detail: string | null;
}

export function osView(device: Pick<Device, "os_caption" | "os_name" | "os_version" | "os_build">): OsView {
  const caption = (device.os_caption || device.os_version || device.os_name || "").trim();
  // Connector platforms pack inventory into os_caption as "Key=value; …".
  const name = caption.includes("=") ? device.os_name || caption : caption.replace(/^Microsoft\s+/i, "");
  const build = Number((device.os_build ?? "").split(".")[2]);
  if (!Number.isFinite(build) || build <= 0) return { name: name || "—", detail: null };
  const release = /server/i.test(name)
    ? null
    : build >= 22000
      ? WINDOWS_11_RELEASES[build]
      : WINDOWS_10_RELEASES[build];
  return { name: name || "—", detail: release ? `${release} · build ${build}` : `Build ${build}` };
}

// Intel family 6 and AMD families by model: the microarchitecture, which is
// what PROCESSOR_IDENTIFIER can tell (it carries no marketing name).
const INTEL_MODELS: Record<number, string> = {
  42: "Sandy Bridge",
  45: "Sandy Bridge-E",
  55: "Bay Trail (Atom/Celeron)",
  58: "Ivy Bridge",
  60: "Haswell",
  62: "Ivy Bridge-E",
  63: "Haswell-E/EP",
  69: "Haswell (mobile)",
  70: "Haswell",
  61: "Broadwell",
  71: "Broadwell",
  79: "Broadwell-E/EP",
  86: "Broadwell-DE",
  78: "Skylake (mobile)",
  94: "Skylake",
  85: "Skylake-SP / Cascade Lake (Xeon)",
  92: "Apollo Lake",
  122: "Gemini Lake",
  142: "Kaby / Whiskey / Amber Lake (mobile)",
  158: "Kaby / Coffee Lake",
  165: "Comet Lake",
  166: "Comet Lake (mobile)",
  106: "Ice Lake-SP (Xeon)",
  108: "Ice Lake-SP (Xeon)",
  125: "Ice Lake",
  126: "Ice Lake (mobile)",
  140: "Tiger Lake (mobile)",
  141: "Tiger Lake",
  143: "Sapphire Rapids (Xeon)",
  151: "Alder Lake",
  154: "Alder Lake (mobile)",
  156: "Jasper Lake",
  167: "Rocket Lake",
  170: "Meteor Lake",
  183: "Raptor Lake",
  186: "Raptor Lake (mobile)",
  190: "Alder Lake-N",
  191: "Raptor Lake",
  197: "Arrow Lake",
  198: "Arrow Lake",
  189: "Lunar Lake",
};
const AMD_FAMILIES: Record<number, string> = {
  21: "Bulldozer family",
  22: "Jaguar / Puma",
  23: "Zen / Zen+ / Zen 2",
  25: "Zen 3 / Zen 4",
  26: "Zen 5",
};

export interface CpuView {
  /** "Intel · Skylake-SP / Cascade Lake (Xeon)", or the reported name as is. */
  name: string;
  /** The raw identifier, when name was decoded from it. */
  raw: string | null;
}

export function cpuView(cpu?: string | null): CpuView | null {
  const text = (cpu ?? "").trim();
  if (!text) return null;
  const id = text.match(/^(Intel64|AMD64|x86|ARM64)?\s*Family (\d+) Model (\d+)(?: Stepping \d+)?,\s*(\w+)/i);
  if (!id) return { name: text, raw: null };
  const family = Number(id[2]);
  const model = Number(id[3]);
  const vendorId = id[4].toLowerCase();
  if (vendorId.includes("intel")) {
    const arch = family === 6 ? INTEL_MODELS[model] : null;
    return { name: `Intel · ${arch ?? `family ${family}, model ${model}`}`, raw: text };
  }
  if (vendorId.includes("amd")) {
    const arch = AMD_FAMILIES[family];
    return { name: `AMD · ${arch ?? `family ${family}, model ${model}`}`, raw: text };
  }
  return { name: text, raw: null };
}

export interface StorageView {
  totalGb: number;
  freeGb: number;
  usedPct: number;
}

/** "76 GB free / 149 GB total" → numbers, or null for any other shape. */
export function storageView(storage?: string | null): StorageView | null {
  const m = (storage ?? "").match(/([\d.]+)\s*GB free\s*\/\s*([\d.]+)\s*GB total/i);
  if (!m) return null;
  const freeGb = Number(m[1]);
  const totalGb = Number(m[2]);
  if (!(totalGb > 0)) return null;
  return { totalGb, freeGb, usedPct: Math.round(((totalGb - freeGb) / totalGb) * 100) };
}
