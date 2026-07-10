import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireFeature, RequirePermission } from "../guards";
import * as platformFeaturesHook from "../../hooks/usePlatformFeatures";
import * as authContext from "../../auth/AuthContext";

// Contract under test (see routes/guards.tsx RequireFeature/RequirePermission):
// a menu item must never be visible if its route would reject the same
// operator for the same feature/permission state. These guards are the
// route half of that contract; Sidebar.test.tsx covers the menu half.
//
// Guarded content is rendered under a real "/reports" Route with a "/" Route
// alongside it (mirroring AppRoutes.tsx), so a redirect actually unmounts the
// guard instead of leaving it mounted to re-navigate every render.
function renderGuardedRoute(children: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/reports"]}>
      <Routes>
        <Route path="/" element={<div>Dashboard</div>} />
        <Route path="/reports" element={children} />
      </Routes>
    </MemoryRouter>,
  );
}

describe.each([
  { label: "Reports", flag: "FEATURE_REPORTING" as const },
  { label: "Vault", flag: "FEATURE_VAULT" as const },
])("RequireFeature ($label)", ({ flag }) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when the flag is ON", () => {
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue({
      FEATURE_PLATFORM_CORE: true,
      FEATURE_LINUX: false,
      FEATURE_VAULT: true,
      FEATURE_TERMINAL: false,
      FEATURE_MIKROTIK: false,
      FEATURE_STORAGE: false,
      FEATURE_HYPERVISOR: false,
      FEATURE_NOTIFICATIONS: false,
      FEATURE_REPORTING: true,
    });
    vi.spyOn(platformFeaturesHook, "usePlatformFeaturesLoading").mockReturnValue(false);

    renderGuardedRoute(
      <RequireFeature flag={flag}>
        <div>Protected content</div>
      </RequireFeature>,
    );

    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("redirects home when the flag is OFF (resolved, not loading)", () => {
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue({
      FEATURE_PLATFORM_CORE: false,
      FEATURE_LINUX: false,
      FEATURE_VAULT: false,
      FEATURE_TERMINAL: false,
      FEATURE_MIKROTIK: false,
      FEATURE_STORAGE: false,
      FEATURE_HYPERVISOR: false,
      FEATURE_NOTIFICATIONS: false,
      FEATURE_REPORTING: false,
    });
    vi.spyOn(platformFeaturesHook, "usePlatformFeaturesLoading").mockReturnValue(false);

    renderGuardedRoute(
      <RequireFeature flag={flag}>
        <div>Protected content</div>
      </RequireFeature>,
    );

    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("does NOT redirect while flags are still loading — renders a loading state instead", () => {
    vi.spyOn(platformFeaturesHook, "usePlatformFeatures").mockReturnValue({
      FEATURE_PLATFORM_CORE: false,
      FEATURE_LINUX: false,
      FEATURE_VAULT: false,
      FEATURE_TERMINAL: false,
      FEATURE_MIKROTIK: false,
      FEATURE_STORAGE: false,
      FEATURE_HYPERVISOR: false,
      FEATURE_NOTIFICATIONS: false,
      FEATURE_REPORTING: false,
    });
    vi.spyOn(platformFeaturesHook, "usePlatformFeaturesLoading").mockReturnValue(true);

    renderGuardedRoute(
      <RequireFeature flag={flag}>
        <div>Protected content</div>
      </RequireFeature>,
    );

    // Neither the guarded content nor a bounce to Dashboard — a transient
    // undefined/false flag state must not be treated as "off".
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});

describe("RequirePermission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when permission is granted", () => {
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      user: { username: "op", display_name: "Op", role: "operator", email: "" } as any,
      token: "t",
      loading: false,
      permissions: ["view_devices"],
      login: vi.fn(),
      logout: vi.fn(),
      can: vi.fn(),
      hasAnyRole: vi.fn(),
      hasPermission: (perm: string) => perm === "view_devices",
    });

    renderGuardedRoute(
      <RequirePermission perm="view_devices">
        <div>Protected content</div>
      </RequirePermission>,
    );

    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("redirects home when permission is denied", () => {
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      user: { username: "op", display_name: "Op", role: "operator", email: "" } as any,
      token: "t",
      loading: false,
      permissions: [],
      login: vi.fn(),
      logout: vi.fn(),
      can: vi.fn(),
      hasAnyRole: vi.fn(),
      hasPermission: () => false,
    });

    renderGuardedRoute(
      <RequirePermission perm="view_devices">
        <div>Protected content</div>
      </RequirePermission>,
    );

    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });
});
