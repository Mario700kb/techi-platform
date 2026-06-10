import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AuthUser, getCurrentUser, getEffectivePermissions, login as loginRequest, UserRole } from "../api/auth";
import { clearAuthSession, getAuthToken, setAuthSession } from "../api/client";

// Module-level singleton — survives React unmount/remount on navigation.
// Guarantees loading=false + permissions ready the instant AuthProvider re-mounts.
interface AuthCacheEntry {
  user: AuthUser;
  token: string;
  permissions: string[] | null;
}
let _authCache: AuthCacheEntry | null = null;

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
  // Cache hit → instant state on re-mount, no API call, no loading flash
  const [user, setUser] = useState<AuthUser | null>(() => {
    if (_authCache) return _authCache.user;
    const raw = window.localStorage.getItem("techi.auth.user");
    return raw ? JSON.parse(raw) as AuthUser : null;
  });
  const [loading, setLoading] = useState(() => _authCache === null && Boolean(token));
  const [permissions, setPermissions] = useState<string[] | null>(() => _authCache?.permissions ?? null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    // Cache warm with same token — skip both API calls, no loading screen
    if (_authCache?.token === token) {
      return;
    }
    let alive = true;
    (async () => {
      try {
        const me = await getCurrentUser();
        if (!alive) return;
        setUser(me);
        setAuthSession(token, me);
        const perms = await getEffectivePermissions();
        if (!alive) return;
        setPermissions(perms.permissions);
        _authCache = { user: me, token, permissions: perms.permissions };
      } catch {
        if (!alive) return;
        clearAuthSession();
        _authCache = null;
        setToken(null);
        setUser(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await loginRequest(username, password);
    setAuthSession(response.access_token, response.user);
    setUser(response.user);
    try {
      const perms = await getEffectivePermissions();
      setPermissions(perms.permissions);
      _authCache = { user: response.user, token: response.access_token, permissions: perms.permissions };
    } catch {
      setPermissions([]);
      _authCache = { user: response.user, token: response.access_token, permissions: [] };
    }
    // setToken LAST — cache is warm before useEffect([token]) re-runs, skipping /auth/me
    setToken(response.access_token);
  }, []);

  const logout = useCallback(() => {
    clearAuthSession();
    _authCache = null;
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

