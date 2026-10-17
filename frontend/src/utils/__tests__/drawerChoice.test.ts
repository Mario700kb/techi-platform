import { describe, expect, it } from "vitest";
import { usesRegistryDrawer } from "../drawerChoice";

describe("usesRegistryDrawer", () => {
  it("keeps Windows on the classic drawer even when it reports a capability", () => {
    expect(usesRegistryDrawer({ platform: "windows", capabilities: { powershell: "" } })).toBe(false);
    expect(usesRegistryDrawer({ platform: null, capabilities: { powershell: "" } })).toBe(false);
  });

  it("uses the registry drawer for other platforms that report capabilities", () => {
    expect(usesRegistryDrawer({ platform: "linux", capabilities: { terminal: "" } })).toBe(true);
    expect(usesRegistryDrawer({ platform: "linux", capabilities: {} })).toBe(false);
  });
});
