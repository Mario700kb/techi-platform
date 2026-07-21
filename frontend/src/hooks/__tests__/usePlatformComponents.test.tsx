import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  componentForFileType,
  FALLBACK_COMPONENTS,
  usePlatformComponents,
} from "../usePlatformComponents";
import type { PlatformComponent } from "../../api/platform";

const getPlatformComponentsMock = vi.fn();

vi.mock("../../api/platform", () => ({
  getPlatformComponents: (...args: unknown[]) => getPlatformComponentsMock(...args),
}));

function Probe() {
  const { components, source } = usePlatformComponents();
  return (
    <div>
      <span data-testid="source">{source}</span>
      <span data-testid="ids">{components.map((c) => c.id).join(",")}</span>
      <span data-testid="owner">
        {componentForFileType(components, "remote_support_dmg")?.id ?? "none"}
      </span>
    </div>
  );
}

describe("usePlatformComponents", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("componentForFileType maps every fallback file_type to its owner", () => {
    const owned = new Map<string, string>();
    for (const component of FALLBACK_COMPONENTS) {
      for (const ft of component.file_types) {
        expect(owned.has(ft)).toBe(false); // no duplicate ownership
        owned.set(ft, component.id);
      }
    }
    expect(owned.get("msi")).toBe("agent");
    expect(owned.get("agent_binary")).toBe("agent");
    expect(owned.get("remote_support_msi")).toBe("remote_support");
    expect(owned.get("remote_support_pkg")).toBe("remote_support");
    expect(componentForFileType(FALLBACK_COMPONENTS, "nope")).toBeUndefined();
  });

  it("renders from the local fallback before/without the endpoint", () => {
    // Never resolves — the page must still work from the fallback.
    getPlatformComponentsMock.mockReturnValue(new Promise(() => {}));
    render(<Probe />);
    expect(screen.getByTestId("source").textContent).toBe("fallback");
    expect(screen.getByTestId("ids").textContent).toBe("agent,remote_support");
    expect(screen.getByTestId("owner").textContent).toBe("remote_support");
  });

  it("upgrades to the live registry on success", async () => {
    const live: PlatformComponent[] = [
      {
        id: "agent",
        display_name: "TECHI Agent",
        description: "d",
        icon_key: "agent",
        platforms: ["windows"],
        file_types: ["msi"],
        lifecycle: [],
        capabilities: [],
        policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
      },
    ];
    getPlatformComponentsMock.mockResolvedValue({ schema_version: 1, components: live });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("source").textContent).toBe("api"));
    expect(screen.getByTestId("ids").textContent).toBe("agent");
  });

  it("keeps the fallback when the endpoint fails (older backend)", async () => {
    getPlatformComponentsMock.mockRejectedValue(new Error("404"));
    render(<Probe />);
    // Give the rejected promise a tick; state must remain the fallback.
    await waitFor(() =>
      expect(screen.getByTestId("ids").textContent).toBe("agent,remote_support"),
    );
    expect(screen.getByTestId("source").textContent).toBe("fallback");
  });
});
