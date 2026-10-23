import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../../api/enrollmentBootstrap";
import { API_BASE_URL } from "../../api/client";
import EnrollmentBootstrap from "../EnrollmentBootstrap";
import { appCache } from "../../store/appCache";

vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ can: () => true }) }));

const TOKENS = [
  {
    id: 4,
    name: "Default Deployment",
    status: "active",
    created_at: "2026-09-01T08:00:00Z",
    expires_at: null,
    used_at: null,
    last_used_at: null,
    max_uses: 500,
    use_count: 1,
    client_id: null,
    group_id: null,
    is_default: true,
    token_prefix: "abcd1234",
    has_recoverable_token: false,
    usage_warning: null,
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <EnrollmentBootstrap />
    </MemoryRouter>,
  );
}

describe("EnrollmentBootstrap", () => {
  beforeEach(() => {
    appCache.invalidate();
    vi.spyOn(api, "getEnrollmentTokens").mockResolvedValue(TOKENS as never);
  });

  it("defaults the backend URL to the API this console uses", async () => {
    renderPage();
    await screen.findByText("Default Deployment");
    expect(screen.getByDisplayValue(API_BASE_URL)).toBeInTheDocument();
  });

  it("offers the platforms an installer exists for, not macOS", async () => {
    renderPage();
    const platforms = await screen.findByRole("radiogroup", { name: "Platform" });
    expect(platforms).toHaveTextContent("Windows");
    expect(platforms).toHaveTextContent("Linux");
    expect(platforms).not.toHaveTextContent("macOS");
  });

  it("keeps no second token table: tokens live under Tokens & commands", async () => {
    renderPage();
    await screen.findByText("Default Deployment");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("link", { name: "Tokens & commands" })).toHaveAttribute("href", "/onboarding?tab=tokens");
  });
});
