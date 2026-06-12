import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { AuthUser, UserRole } from "../api/auth";
import {
  bootstrapSession,
  clearSession,
  loginSession,
  useSessionStore,
} from "../store/sessionStore";

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  /** null = admin/owner bypass (all permissions granted), string[] = explicit list */
  permissions: string[] | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
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
  const { token, user, loading, permissions } = useSessionStore();

  useEffect(() => {
    void bootstrapSession();
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    await loginSession(username, password);
  }, []);

  const logout = useCallback(() => {
    clearSession();
  }, []);

  const can = useCallback((role: UserRole) => {
    if (!user) return false;
    return roleRank[user.role] >= roleRank[role];
  }, [user]);

  const hasAnyRole = useCallback((roles: UserRole[]) => {
    if (!user) return false;
    return user.role === "owner" || roles.includes(user.role);
  }, [user]);

  const hasPermission = useCallback((perm: string) => {
    if (!user) return false;
    if (user.role === "owner" || user.role === "admin") return true;
    if (permissions === null) return false;
    return permissions.includes(perm);
  }, [user, permissions]);

  const value = useMemo(
    () => ({ user, token, loading, permissions, login, logout, can, hasAnyRole, hasPermission }),
    [user, token, loading, permissions, login, logout, can, hasAnyRole, hasPermission],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
