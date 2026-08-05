import { Route, Routes } from "react-router-dom";
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
import TerminalWindow from "../pages/TerminalWindow";
import CredentialVault from "../pages/CredentialVault";
import NotificationSettings from "../pages/NotificationSettings";
import Reports from "../pages/Reports";
import { RequireAuth, RequireFeature, RequirePermission } from "./guards";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/devices" element={<RequireAuth><RequirePermission perm="view_devices"><Devices /></RequirePermission></RequireAuth>} />
      <Route path="/devices/:id" element={<RequireAuth><RequirePermission perm="view_devices"><DeviceDetailsMobile /></RequirePermission></RequireAuth>} />
      {/* Chrome-free target for window.open from the Device Catalog: the
          terminal gets its own browser window, movable to a second screen.
          Same guards as the catalog; the backend enforces the real gate. */}
      <Route path="/terminal/:id" element={<RequireAuth><RequirePermission perm="view_devices"><TerminalWindow /></RequirePermission></RequireAuth>} />
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
