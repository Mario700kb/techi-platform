import { describe, expect, it, vi } from "vitest";

import { RemoteSupportLaunchCoordinator } from "./remoteSupportConnect";
import { validateTokenOnlyConnectUrl } from "./rustdeskLaunch";

const token = "A".repeat(43);

describe("secure Remote Support launch", () => {
  it("accepts a token-only URI without device credentials", () => {
    const url = `techiremotesupport://connect?token=${token}`;
    expect(validateTokenOnlyConnectUrl(url)).toBe(url);
    expect(url).not.toContain("password");
    expect(url).not.toContain("486641675");
  });

  it.each([
    `techiremotesupport://connect?token=${token}&password=secret`,
    `techiremotesupport://486641675?token=${token}`,
    `rustdesk://connect?token=${token}`,
    `techiremotesupport://connect?token=${token}#secret`,
    "techiremotesupport://connect?token=short",
  ])("rejects non-contract URI %s", (url) => {
    expect(() => validateTokenOnlyConnectUrl(url)).toThrow("Invalid secure Remote Support launch URL");
  });

  it("ignores a stale device response", async () => {
    const coordinator = new RemoteSupportLaunchCoordinator();
    const open = vi.fn();
    let resolveFirst!: (value: {
      device_id: number;
      connect_url: string;
      expires_at: string;
      expires_in_seconds: number;
    }) => void;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
      resolveFirst = resolve;
    });
    const firstLaunch = coordinator.launch(11, () => first, open);
    const secondLaunch = coordinator.launch(
      12,
      async () => ({
        device_id: 12,
        connect_url: `techiremotesupport://connect?token=${"B".repeat(43)}`,
        expires_at: "2026-07-15T12:00:00Z",
        expires_in_seconds: 45,
      }),
      open,
    );
    resolveFirst({
      device_id: 11,
      connect_url: `techiremotesupport://connect?token=${token}`,
      expires_at: "2026-07-15T12:00:00Z",
      expires_in_seconds: 45,
    });

    expect(await secondLaunch).toBe(true);
    expect(await firstLaunch).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toContain("B".repeat(43));
  });

  it("rejects a response bound to another device", async () => {
    const coordinator = new RemoteSupportLaunchCoordinator();
    const open = vi.fn();
    const launched = await coordinator.launch(
      12,
      async () => ({
        device_id: 11,
        connect_url: `techiremotesupport://connect?token=${token}`,
        expires_at: "2026-07-15T12:00:00Z",
        expires_in_seconds: 45,
      }),
      open,
    );
    expect(launched).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
