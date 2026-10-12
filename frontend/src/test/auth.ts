import { vi } from "vitest";

/** The AuthContext fields most page tests do not care about. Spread first, override after. */
export const AUTH_DEFAULTS = {
  sessionExpiresAt: null,
  mfaEnrollmentRequired: false,
  completeMfa: vi.fn(),
  reloadSession: vi.fn(),
};
