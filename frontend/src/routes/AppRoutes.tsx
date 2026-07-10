import { Route, Routes } from "react-router-dom";
import { Navigate, useLocation } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import Dashboard from "../pages/Dashboard";
import Devices from "../pages/Devices";
import Clients from "../pages/Clients";
import Audit from "../pages/Audit";
import AgentPackages from "../pages/AgentPackages";
import Deployment from "../pages/Deployment";
import EnrollmentBootstrap from "../pages/EnrollmentBootstrap";
import Inventory from "../pages/Inventory";
import Operators from "../pages/Operators";
import RemoteSupport from "../pages/RemoteSupport";
import Teams from "../pages/Teams";
import TeamDetailPage from "../pages/TeamDetail";
import Login from "../pages/Login";
import AgentConfigPage from "../pages/AgentConfig";
import AlertsMobile from "../pages/AlertsMobile";
import More from "../pages/More";
import Settings from "../pages/Settings";
import DeviceDetailsMobile from "../pages/DeviceDetailsMobile";
import CredentialVault from "../pages/CredentialVault";
import NotificationSettings from "../pages/NotificationSettings";
import Reports from "../pages/Reports";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-4 text-sm font-medium text-slate-400">Loading session...</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const { hasPermission, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-4 text-sm font-medium text-slate-400">Loading session...</div>;
  if (!hasPermission(perm)) return <Navigate to="/" replace state={{ from: location }} />;
  return <>{children}</>;
}

// Platform Expansion route guard: while flags load, treat as off; a route
// gated by an OFF flag redirects home so nothing new is reachable.
function RequireFeature({ flag, children }: { flag: "FEATURE_VAULT" | "FEATURE_NOTIFICATIONS" | "FEATURE_REPORTING"; children: ReactNode }) {
  const features = usePlatformFeatures();
  if (!features[flag]) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/devices" element={<RequireAuth><RequirePermission perm="view_devices"><Devices /></RequirePermission></RequireAuth>} />
      <Route path="/devices/:id" element={<RequireAuth><RequirePermission perm="view_devices"><DeviceDetailsMobile /></RequirePermission></RequireAuth>} />
      <Route path="/clients" element={<RequireAuth><RequirePermission perm="manage_clients"><Clients /></RequirePermission></RequireAuth>} />
      <Route path="/deployment" element={<RequireAuth><RequirePermission perm="deployment"><Deployment /></RequirePermission></RequireAuth>} />
      <Route path="/enrollment-bootstrap" element={<RequireAuth><RequirePermission perm="deployment"><EnrollmentBootstrap /></RequirePermission></RequireAuth>} />
      <Route path="/agent-packages" element={<RequireAuth><RequirePermission perm="deployment"><AgentPackages /></RequirePermission></RequireAuth>} />
      <Route path="/inventory" element={<RequireAuth><RequirePermission perm="view_inventory"><Inventory /></RequirePermission></RequireAuth>} />
      <Route path="/operators" element={<RequireAuth><RequirePermission perm="manage_operators"><Operators /></RequirePermission></RequireAuth>} />
      <Route path="/teams" element={<RequireAuth><RequirePermission perm="manage_teams"><Teams /></RequirePermission></RequireAuth>} />
      <Route path="/teams/:id" element={<RequireAuth><RequirePermission perm="manage_teams"><TeamDetailPage /></RequirePermission></RequireAuth>} />
      <Route path="/audit" element={<RequireAuth><RequirePermission perm="audit_log"><Audit /></RequirePermission></RequireAuth>} />
      <Route path="/remote-support" element={<RequireAuth><RemoteSupport /></RequireAuth>} />
      <Route path="/agent-config" element={<RequireAuth><RequirePermission perm="system_settings"><AgentConfigPage /></RequirePermission></RequireAuth>} />
      <Route path="/vault" element={<RequireAuth><RequirePermission perm="system_settings"><RequireFeature flag="FEATURE_VAULT"><CredentialVault /></RequireFeature></RequirePermission></RequireAuth>} />
      <Route path="/notifications" element={<RequireAuth><RequirePermission perm="system_settings"><RequireFeature flag="FEATURE_NOTIFICATIONS"><NotificationSettings /></RequireFeature></RequirePermission></RequireAuth>} />
      <Route path="/reports" element={<RequireAuth><RequirePermission perm="view_devices"><RequireFeature flag="FEATURE_REPORTING"><Reports /></RequireFeature></RequirePermission></RequireAuth>} />
      <Route path="/alerts" element={<RequireAuth><AlertsMobile /></RequireAuth>} />
      <Route path="/more" element={<RequireAuth><More /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
    </Routes>
  );
}
