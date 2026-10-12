import { AUTH_DEFAULTS } from "../../test/auth";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SecurityCard, { describeUserAgent } from "../security/SecurityCard";
import * as authContext from "../../auth/AuthContext";
import * as authApi from "../../api/auth";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function session(id: string, current: boolean, ua: string): authApi.OperatorSession {
  return {
    id,
    current,
    user_agent: ua,
    ip_address: "10.0.0.5",
    created_at: "2026-10-12T08:00:00Z",
    last_used_at: "2026-10-12T09:00:00Z",
    expires_at: "2026-10-12T20:00:00Z",
  };
}

describe("SecurityCard", () => {
  const reloadSession = vi.fn();

  beforeEach(() => {
    vi.spyOn(authContext, "useAuth").mockReturnValue({
      user: { username: "op", email: "op@techi.al", role: "operator" } as any,
      ...AUTH_DEFAULTS,
      reloadSession,
      loading: false,
      permissions: [],
      login: vi.fn(),
      logout: vi.fn(),
      can: vi.fn(),
      hasAnyRole: vi.fn(),
      hasPermission: () => true,
    });
    vi.spyOn(authApi, "getMfaStatus").mockResolvedValue({
      enabled: false,
      enabled_at: null,
      required: false,
      recovery_codes_remaining: 0,
    });
    vi.spyOn(authApi, "listSessions").mockResolvedValue([
      session("a", true, CHROME_WINDOWS),
      session("b", false, SAFARI_IPHONE),
    ]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("lists signed-in browsers and offers to sign out the others", async () => {
    render(<SecurityCard />);
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Safari on iOS")).toBeInTheDocument();
    expect(screen.getByText("This browser")).toBeInTheDocument();

    const revokeOthers = vi.spyOn(authApi, "revokeOtherSessions").mockResolvedValue({ revoked: 1 });
    fireEvent.click(screen.getByRole("button", { name: /sign out the others \(1\)/i }));
    await waitFor(() => expect(revokeOthers).toHaveBeenCalledTimes(1));
  });

  it("turns on two-factor authentication and shows the recovery codes once", async () => {
    vi.spyOn(authApi, "startMfaSetup").mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauth_uri: "otpauth://totp/TECHI%20Connect:op@techi.al?secret=JBSWY3DPEHPK3PXP&issuer=TECHI%20Connect",
    });
    const enable = vi.spyOn(authApi, "enableMfa").mockResolvedValue(["aaaaa-11111", "bbbbb-22222"]);

    render(<SecurityCard />);
    fireEvent.click(await screen.findByRole("button", { name: /turn on/i }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("img", { name: /qr code/i })).toBeInTheDocument();
    expect(within(dialog).getByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByPlaceholderText("123456"), { target: { value: "12 34 56" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^turn on$/i }));

    await waitFor(() => expect(enable).toHaveBeenCalledWith("123456"));
    expect(await within(dialog).findByText("aaaaa-11111")).toBeInTheDocument();
    // The footer's submit is gone once the codes show; only the acknowledgement remains.
    expect(within(dialog).queryByRole("button", { name: /^turn on$/i })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /i saved my recovery codes/i }));
    await waitFor(() => expect(reloadSession).toHaveBeenCalled());
  });
});

describe("describeUserAgent", () => {
  it("names the browser and OS", () => {
    expect(describeUserAgent(CHROME_WINDOWS)).toEqual({ label: "Chrome on Windows", mobile: false });
    expect(describeUserAgent(SAFARI_IPHONE)).toEqual({ label: "Safari on iOS", mobile: true });
    expect(describeUserAgent(null).label).toBe("Unknown browser");
  });
});
