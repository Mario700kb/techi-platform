import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { usePlatformFeatures, usePlatformFeaturesLoading } from "../hooks/usePlatformFeatures";
import AppPreloader from "../components/AppPreloader";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AppPreloader inline label="Loading session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

export function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const { hasPermission, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AppPreloader inline label="Loading session" />;
  if (!hasPermission(perm)) return <Navigate to="/" replace state={{ from: location }} />;
  return <>{children}</>;
}

export type PlatformFeatureFlag = "FEATURE_VAULT" | "FEATURE_NOTIFICATIONS" | "FEATURE_REPORTING";

// Platform Expansion route guard: while flags are still loading, render a
// loading state rather than redirecting — a flag that is merely unresolved
// is not the same as a flag that is OFF. Only redirect home once the fetch
// has settled and the flag is actually off.
export function RequireFeature({ flag, children }: { flag: PlatformFeatureFlag; children: ReactNode }) {
  const features = usePlatformFeatures();
  const loading = usePlatformFeaturesLoading();
  if (loading) return <AppPreloader inline label="Loading" />;
  if (!features[flag]) return <Navigate to="/" replace />;
  return <>{children}</>;
}
