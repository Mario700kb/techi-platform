import { describe, expect, it, vi } from "vitest";

import { RemoteSupportLaunchCoordinator } from "./remoteSupportConnect";

describe("Remote Support launch", () => {
  it("ignores a stale device response", async () => {
    const coordinator = new RemoteSupportLaunchCoordinator();
    const open = vi.fn();
    let resolveFirst!: (value: {
      device_id: number;
      techi_remote_id: string;
      connect_url: string;
    }) => void;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>((resolve) => {
      resolveFirst = resolve;
    });
    const firstLaunch = coordinator.launch(11, () => first, open);
    const secondLaunch = coordinator.launch(
      12,
      async () => ({
        device_id: 12,
        techi_remote_id: "486641676",
        connect_url: "techiremotesupport://486641676",
      }),
      open,
    );
    resolveFirst({
      device_id: 11,
      techi_remote_id: "486641675",
      connect_url: "techiremotesupport://486641675",
    });

    expect(await secondLaunch).toBe(true);
    expect(await firstLaunch).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe("techiremotesupport://486641676");
    expect(open.mock.calls[0][1]).toBe("rustdesk://486641676");
  });

  it("rejects a response bound to another device", async () => {
    const coordinator = new RemoteSupportLaunchCoordinator();
    const open = vi.fn();
    const launched = await coordinator.launch(
      12,
      async () => ({
        device_id: 11,
        techi_remote_id: "486641675",
        connect_url: "techiremotesupport://486641675",
      }),
      open,
    );
    expect(launched).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the legacy connect-url launcher instead of token redemption", async () => {
    const coordinator = new RemoteSupportLaunchCoordinator();
    const open = vi.fn();
    const onFallback = vi.fn();

    const launched = await coordinator.launch(
      44,
      async () => ({
        device_id: 44,
        techi_remote_id: "486641677",
        connect_url: "techiremotesupport://486641677",
      }),
      open,
      onFallback,
    );

    expect(launched).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "techiremotesupport://486641677",
      "rustdesk://486641677",
      onFallback,
    );
    expect(open.mock.calls[0][0]).not.toContain("connect?token=");
  });
});
