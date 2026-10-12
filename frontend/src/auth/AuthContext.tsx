import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { AuthUser, UserRole } from "../api/auth";
import {
  bootstrapSession,
  completeMfaLogin,
  loginSession,
  logoutSession,
  reloadSession,
  useSessionStore,
} from "../store/sessionStore";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** When the server ends this session regardless of activity (ISO, UTC). */
  sessionExpiresAt: string | null;
  /** The operator's role requires two-factor authentication they have not set up. */
  mfaEnrollmentRequired: boolean;
  /** null = admin/owner bypass (all permissions granted), string[] = explicit list */
  permissions: string[] | null;
  /** Password step; resolves with an MFA challenge when the account has 2FA on. */
  login: (username: string, password: string) => Promise<{ mfaToken: string } | null>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => void;
  reloadSession: () => Promise<void>;
  can: (role: UserRole) => boolean;
  hasAnyRole: (roles: UserRole[]) => boolean;
  hasPermission: (perm: string) => boolean;
}

const roleRank: Record<UserRole, number> = {
  readonly: 0,
  operator: 1,
  admin: 2,
  owner: 3,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user, loading, permissions, sessionExpiresAt, mfaEnrollmentRequired } = useSessionStore();

  useEffect(() => {
    void bootstrapSession();
  }, []);

  const login = useCallback((username: string, password: string) => loginSession(username, password), []);
  const completeMfa = useCallback((mfaToken: string, code: string) => completeMfaLogin(mfaToken, code), []);

  const logout = useCallback(() => {
    void logoutSession();
  }, []);

  const can = useCallback(
    (role: UserRole) => {
      if (!user) return false;
      return roleRank[user.role] >= roleRank[role];
    },
    [user],
  );

  const hasAnyRole = useCallback(
    (roles: UserRole[]) => {
      if (!user) return false;
      return user.role === "owner" || roles.includes(user.role);
    },
    [user],
  );

  const hasPermission = useCallback(
    (perm: string) => {
      if (!user) return false;
      if (user.role === "owner" || user.role === "admin") return true;
      if (permissions === null) return false;
      return permissions.includes(perm);
    },
    [user, permissions],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      permissions,
      sessionExpiresAt,
      mfaEnrollmentRequired,
      login,
      completeMfa,
      logout,
      reloadSession,
      can,
      hasAnyRole,
      hasPermission,
    }),
    [
      user,
      loading,
      permissions,
      sessionExpiresAt,
      mfaEnrollmentRequired,
      login,
      completeMfa,
      logout,
      can,
      hasAnyRole,
      hasPermission,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
