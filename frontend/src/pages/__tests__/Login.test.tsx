import { AUTH_DEFAULTS } from "../../test/auth";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Login from "../Login";
import * as authContext from "../../auth/AuthContext";
import * as themeContext from "../../contexts/ThemeContext";

function mockAuth(overrides: Partial<ReturnType<typeof authContext.useAuth>>) {
  vi.spyOn(authContext, "useAuth").mockReturnValue({
    user: null,
    ...AUTH_DEFAULTS,
    loading: false,
    permissions: null,
    login: vi.fn(),
    logout: vi.fn(),
    can: vi.fn(),
    hasAnyRole: vi.fn(),
    hasPermission: vi.fn(),
    ...overrides,
  });
}

function renderLogin() {
  vi.spyOn(themeContext, "useTheme").mockReturnValue({ theme: "dark" } as any);
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

function signIn() {
  fireEvent.change(screen.getByLabelText(/username or email/i), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "secret-pass" } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
}

describe("Login", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for the authenticator code when the account has 2FA on", async () => {
    const completeMfa = vi.fn().mockResolvedValue(undefined);
    mockAuth({ login: vi.fn().mockResolvedValue({ mfaToken: "challenge" }), completeMfa });
    renderLogin();
    signIn();

    expect(await screen.findByRole("heading", { name: /two-factor authentication/i })).toBeInTheDocument();
    const code = screen.getByLabelText(/authentication code/i);
    fireEvent.change(code, { target: { value: "12a3456" } });
    expect(code).toHaveValue("123456");
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
    await waitFor(() => expect(completeMfa).toHaveBeenCalledWith("challenge", "123456"));
  });

  it("accepts a recovery code instead", async () => {
    const completeMfa = vi.fn().mockResolvedValue(undefined);
    mockAuth({ login: vi.fn().mockResolvedValue({ mfaToken: "challenge" }), completeMfa });
    renderLogin();
    signIn();

    fireEvent.click(await screen.findByRole("button", { name: /use a recovery code/i }));
    fireEvent.change(screen.getByLabelText(/recovery code/i), { target: { value: "abcde-12345" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
    await waitFor(() => expect(completeMfa).toHaveBeenCalledWith("challenge", "abcde-12345"));
  });

  it("shows the server's message for a wrong code and stays on the code step", async () => {
    mockAuth({
      login: vi.fn().mockResolvedValue({ mfaToken: "challenge" }),
      completeMfa: vi.fn().mockRejectedValue(new Error("That code is not valid")),
    });
    renderLogin();
    signIn();
    fireEvent.change(await screen.findByLabelText(/authentication code/i), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not valid");
    expect(screen.getByRole("heading", { name: /two-factor authentication/i })).toBeInTheDocument();
  });

  it("signs in directly when the account has no 2FA", async () => {
    const login = vi.fn().mockResolvedValue(null);
    mockAuth({ login });
    renderLogin();
    signIn();
    await waitFor(() => expect(login).toHaveBeenCalledWith("alice", "secret-pass"));
    expect(await screen.findByRole("button", { name: /signed in/i })).toBeInTheDocument();
  });
});
