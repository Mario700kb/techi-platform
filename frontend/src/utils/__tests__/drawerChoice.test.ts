import { describe, expect, it } from "vitest";
import { usesRegistryDrawer } from "../drawerChoice";

describe("usesRegistryDrawer", () => {
  it("keeps Windows on the classic drawer even when it reports a capability", () => {
    expect(usesRegistryDrawer({ platform: "windows", capabilities: { powershell: "" } })).toBe(false);
    expect(usesRegistryDrawer({ platform: null, capabilities: { powershell: "" } })).toBe(false);
  });

  it("puts Linux on the classic drawer too (its root terminal is the Maintenance console)", () => {
    expect(usesRegistryDrawer({ platform: "linux", capabilities: { terminal: "", remote_support: "" } })).toBe(false);
    expect(usesRegistryDrawer({ platform: "Linux", capabilities: {} })).toBe(false);
  });

  it("uses the registry drawer for other platforms that report capabilities", () => {
    expect(usesRegistryDrawer({ platform: "mikrotik", capabilities: { winbox: "" } })).toBe(true);
    expect(usesRegistryDrawer({ platform: "mikrotik", capabilities: {} })).toBe(false);
  });
});
