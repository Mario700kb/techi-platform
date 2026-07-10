import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Settings from "../Settings";
import * as authContext from "../../auth/AuthContext";
import * as themeContext from "../../contexts/ThemeContext";
import * as appDataContext from "../../contexts/AppDataContext";
import * as connectApi from "../../api/connect";

// Section G: "Provide settings to view/reset defaults" — the Connect
// Defaults section on the Settings page.

function mockShell() {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: { username: "op", display_name: "Op", role: "admin", email: "" } as any,
    token: "t", loading: false, permissions: null,
    login: vi.fn(), logout: vi.fn(), can: () => true, hasAnyRole: vi.fn(), hasPermission: () => true,
  });
  vi.spyOn(themeContext, "useTheme").mockReturnValue({
    themePreference: "dark", setThemeMode: vi.fn(),
  } as any);
  vi.spyOn(appDataContext, "useAppData").mockReturnValue({
    fleetOverview: null, realtimeStatus: "connected",
  } as any);
}

describe("Settings — Connect Defaults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is absent when the operator has no saved preferences", async () => {
    mockShell();
    vi.spyOn(connectApi, "listConnectPreferences").mockResolvedValue([]);
    render(<Settings />);
    await waitFor(() => expect(screen.getByText("Preferences")).toBeInTheDocument());
    expect(screen.queryByText("Connect Defaults")).not.toBeInTheDocument();
  });

  it("lists saved preferences with platform, device (if any), and method", async () => {
    mockShell();
    vi.spyOn(connectApi, "listConnectPreferences").mockResolvedValue([
      { platform: "mikrotik", device_id: null, method_id: "ssh" },
      { platform: "linux", device_id: 733, method_id: "web_terminal" },
    ]);
    render(<Settings />);

    await waitFor(() => expect(screen.getByText("Connect Defaults")).toBeInTheDocument());
    expect(screen.getByText("mikrotik")).toBeInTheDocument();
    expect(screen.getByText("ssh")).toBeInTheDocument();
    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.getByText("web_terminal")).toBeInTheDocument();
    expect(screen.getByText("device #733")).toBeInTheDocument();
  });

  it("reset button calls resetConnectPreference and removes the row", async () => {
    mockShell();
    vi.spyOn(connectApi, "listConnectPreferences").mockResolvedValue([
      { platform: "mikrotik", device_id: null, method_id: "ssh" },
    ]);
    const resetSpy = vi.spyOn(connectApi, "resetConnectPreference").mockResolvedValue(undefined);
    render(<Settings />);

    await waitFor(() => expect(screen.getByText("Connect Defaults")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Reset to the platform default"));

    await waitFor(() => expect(resetSpy).toHaveBeenCalledWith("mikrotik", undefined));
    await waitFor(() => expect(screen.queryByText("Connect Defaults")).not.toBeInTheDocument());
  });
});
