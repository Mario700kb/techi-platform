import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { usePlatformFeatures, usePlatformFeaturesLoading } from "../hooks/usePlatformFeatures";
import AppPreloader from "../components/AppPreloader";
import { AccessDenied } from "../pages/StatusPages";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AppPreloader inline label="Loading session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

export function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const { hasPermission, loading } = useAuth();
  if (loading) return <AppPreloader inline label="Loading session" />;
  // Say so instead of bouncing to the Dashboard: a silent redirect reads as
  // a broken link.
  if (!hasPermission(perm)) return <AccessDenied />;
  return <>{children}</>;
}

export type PlatformFeatureFlag = "FEATURE_VAULT" | "FEATURE_NOTIFICATIONS" | "FEATURE_REPORTING";

// Platform Expansion route guard. While the flags load, the last flags this
// browser was told decide: a page whose flag was on opens at once instead of
// an empty shell with a loading bar (the API enforces every flag itself). A
// flag that is merely unresolved is not the same as one that is OFF, so with
// no such flag it shows a loading state, and it redirects home only once the
// fetch has settled and the flag is actually off.
export function RequireFeature({ flag, children }: { flag: PlatformFeatureFlag; children: ReactNode }) {
  const features = usePlatformFeatures();
  const loading = usePlatformFeaturesLoading();
  if (features[flag]) return <>{children}</>;
  if (loading) return <AppPreloader inline label="Loading" />;
  return <Navigate to="/" replace />;
}
