import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AuthUser, getCurrentUser, getEffectivePermissions, login as loginRequest, UserRole } from "../api/auth";
import { clearAuthSession, getAuthToken, setAuthSession } from "../api/client";

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
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = window.localStorage.getItem("techi.auth.user");
    return raw ? JSON.parse(raw) as AuthUser : null;
  });
  const [loading, setLoading] = useState(Boolean(token));
  const [permissions, setPermissions] = useState<string[] | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let alive = true;
    getCurrentUser()
      .then((me) => {
        if (!alive) return;
        setUser(me);
        setAuthSession(token, me);
        return getEffectivePermissions();
      })
      .then((perms) => {
        if (!alive || !perms) return;
        // null means bypass (admin/owner) — backend returns full role permissions for them,
        // but we detect bypass by checking if permissions equals all role permissions.
        // Simpler: backend signals bypass by returning the role's full set.
        // We store null for admin/owner (role rank >= admin), string[] for operator/readonly.
        setPermissions(perms.permissions);
      })
      .catch(() => {
        if (!alive) return;
        clearAuthSession();
        setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await loginRequest(username, password);
    setAuthSession(response.access_token, response.user);
    setToken(response.access_token);
    setUser(response.user);
    try {
      const perms = await getEffectivePermissions();
      setPermissions(perms.permissions);
    } catch {
      setPermissions([]);
    }
  }, []);

  const logout = useCallback(() => {
    clearAuthSession();
    setToken(null);
    setUser(null);
    setPermissions(null);
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

