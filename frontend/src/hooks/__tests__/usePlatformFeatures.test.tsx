import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every test gets a fresh copy of the module-level store, since it caches
// state across imports (see usePlatformFeatures.ts).
async function loadHook() {
  vi.resetModules();
  return import("../usePlatformFeatures");
}

const getPlatformFeaturesMock = vi.fn();

vi.mock("../../api/platform", () => ({
  getPlatformFeatures: (...args: unknown[]) => getPlatformFeaturesMock(...args),
}));

function Probe({
  usePlatformFeatures,
  usePlatformFeaturesLoading,
}: {
  usePlatformFeatures: () => { FEATURE_REPORTING: boolean };
  usePlatformFeaturesLoading: () => boolean;
}) {
  const features = usePlatformFeatures();
  const loading = usePlatformFeaturesLoading();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="reporting">{String(features.FEATURE_REPORTING)}</span>
    </div>
  );
}

describe("usePlatformFeatures shared store", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts loading and resolves to the fetched flags", async () => {
    let resolveFetch: (v: Record<string, boolean>) => void = () => {};
    getPlatformFeaturesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { usePlatformFeatures, usePlatformFeaturesLoading } = await loadHook();

    render(<Probe usePlatformFeatures={usePlatformFeatures} usePlatformFeaturesLoading={usePlatformFeaturesLoading} />);

    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("reporting").textContent).toBe("false");

    await act(async () => {
      resolveFetch({ FEATURE_REPORTING: true });
    });

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("reporting").textContent).toBe("true");
  });

  it("shares one fetch across multiple consumers mounting at different times", async () => {
    let resolveFetch: (v: Record<string, boolean>) => void = () => {};
    getPlatformFeaturesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { usePlatformFeatures, usePlatformFeaturesLoading } = await loadHook();

    // First consumer mounts (e.g. the Sidebar) and the fetch resolves.
    const first = render(<Probe usePlatformFeatures={usePlatformFeatures} usePlatformFeaturesLoading={usePlatformFeaturesLoading} />);
    await act(async () => {
      resolveFetch({ FEATURE_REPORTING: true });
    });
    await waitFor(() => expect(screen.getAllByTestId("loading")[0].textContent).toBe("false"));
    first.unmount();

    // A second consumer (e.g. a route guard) mounts afterwards. It must see
    // the already-resolved snapshot immediately instead of starting a new
    // fetch from a loading/ALL_OFF state.
    render(<Probe usePlatformFeatures={usePlatformFeatures} usePlatformFeaturesLoading={usePlatformFeaturesLoading} />);
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("reporting").textContent).toBe("true");
    expect(getPlatformFeaturesMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed fetch, so a later mount can retry", async () => {
    getPlatformFeaturesMock.mockRejectedValueOnce(new Error("401"));
    const { usePlatformFeatures, usePlatformFeaturesLoading } = await loadHook();

    const first = render(<Probe usePlatformFeatures={usePlatformFeatures} usePlatformFeaturesLoading={usePlatformFeaturesLoading} />);
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("reporting").textContent).toBe("false");
    first.unmount();

    getPlatformFeaturesMock.mockResolvedValueOnce({ FEATURE_REPORTING: true });
    render(<Probe usePlatformFeatures={usePlatformFeatures} usePlatformFeaturesLoading={usePlatformFeaturesLoading} />);
    await waitFor(() => expect(screen.getByTestId("reporting").textContent).toBe("true"));
    expect(getPlatformFeaturesMock).toHaveBeenCalledTimes(2);
  });
});
