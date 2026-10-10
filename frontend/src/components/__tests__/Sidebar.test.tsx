import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../Sidebar";
import * as authContext from "../../auth/AuthContext";
import * as platformFeaturesHook from "../../hooks/usePlatformFeatures";
import * as appDataContext from "../../contexts/AppDataContext";

// Contract under test: a menu item must never be visible if its route would
// reject the same operator for the same feature/permission state (see the
// route half of this contract in routes/__tests__/AppRoutes.guards.test.tsx).

const ALL_FEATURES_OFF = {
  FEATURE_PLATFORM_CORE: false,
  FEATURE_LINUX: false,
  FEATURE_VAULT: false,
  FEATURE_TERMINAL: false,
  FEATURE_MIKROTIK: false,
  FEATURE_STORAGE: false,
  FEATURE_HYPERVISOR: false,
  FEATURE_NOTIFICATIONS: false,
  FEATURE_REPORTING: false,
};

function mockAuth(hasPermission: (perm: string) => boolean) {
  // The sidebar shows live device/alert counts; none are needed for this contract.
  vi.spyOn(appDataContext, "useAppData").mockReturnValue({
    fleetOverview: null,
    totalOpenAlerts: 0,
    alertCount: { total_open: 0, by_severity: {} },
  } as any);
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: { username: "op", display_name: "Op", role: "operator", email: "" } as any,
    token: "t",
    loading: false,
    permissions: [],
    login: vi.fn(),
    logout: vi.fn(),
    can: vi.fn(),
    hasAnyRole: vi.fn(),
    hasPermission,
  });
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar collapsed={false} />
    </MemoryRouter>,
  );
}

describe.each([
  { label: "Reports", flag: "FEATURE_REPORTING" as const, perm: "view_devices" },
  { label: "Credential Vault", flag: "FEATURE_VAULT" as const, perm: "system_settings" },
])("Sidebar menu item: $label", ({ label, flag, perm }) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is visible when flag is ON and permission is allowed", () => {
    mockAuth(() => true);
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue({
      ...ALL_FEATURES_OFF,
      [flag]: true,
    });

    renderSidebar();
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("is hidden when the flag is OFF, even with permission allowed", () => {
    mockAuth(() => true);
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue(ALL_FEATURES_OFF);

    renderSidebar();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it("is hidden while flags are still loading (default all-off snapshot)", () => {
    mockAuth(() => true);
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue(ALL_FEATURES_OFF);

    renderSidebar();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it("is hidden when permission is denied, even with the flag ON", () => {
    mockAuth((p) => p !== perm);
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue({
      ...ALL_FEATURES_OFF,
      [flag]: true,
    });

    renderSidebar();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  });
});
