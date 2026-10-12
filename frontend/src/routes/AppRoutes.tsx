import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AppPreloader from "../components/AppPreloader";
// The sign-in screen and the Dashboard are what nearly every visit starts
// on, so they ship in the main bundle; every other page is its own chunk,
// fetched the first time it is opened.
import Dashboard from "../pages/Dashboard";
import Login from "../pages/Login";

const Devices = lazy(() => import("../pages/Devices"));
const Clients = lazy(() => import("../pages/Clients"));
const Audit = lazy(() => import("../pages/Audit"));
const Onboarding = lazy(() => import("../pages/Onboarding"));
const Inventory = lazy(() => import("../pages/Inventory"));
const Operators = lazy(() => import("../pages/Operators"));
const Teams = lazy(() => import("../pages/Teams"));
const TeamDetailPage = lazy(() => import("../pages/TeamDetail"));
const AgentConfigPage = lazy(() => import("../pages/AgentConfig"));
const Alerts = lazy(() => import("../pages/Alerts"));
const More = lazy(() => import("../pages/More"));
const Settings = lazy(() => import("../pages/Settings"));
const DeviceDetailsMobile = lazy(() => import("../pages/DeviceDetailsMobile"));
const TerminalWindow = lazy(() => import("../pages/TerminalWindow"));
const CredentialVault = lazy(() => import("../pages/CredentialVault"));
const NotificationSettings = lazy(() => import("../pages/NotificationSettings"));
const Reports = lazy(() => import("../pages/Reports"));
import { NotFound } from "../pages/StatusPages";
import { RequireAuth, RequireFeature, RequirePermission } from "./guards";

export default function AppRoutes() {
  return (
    <Suspense fallback={<AppPreloader inline label="Loading" />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Dashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/devices"
          element={
            <RequireAuth>
              <RequirePermission perm="view_devices">
                <Devices />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/devices/:id"
          element={
            <RequireAuth>
              <RequirePermission perm="view_devices">
                <DeviceDetailsMobile />
              </RequirePermission>
            </RequireAuth>
          }
        />
        {/* Chrome-free target for window.open from the Device Catalog: the
            terminal gets its own browser window, movable to a second screen.
            Same guards as the catalog; the backend enforces the real gate. */}
        <Route
          path="/terminal/:id"
          element={
            <RequireAuth>
              <RequirePermission perm="view_devices">
                <TerminalWindow />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/clients"
          element={
            <RequireAuth>
              <RequirePermission perm="manage_clients">
                <Clients />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/onboarding"
          element={
            <RequireAuth>
              <RequirePermission perm="deployment">
                <Onboarding />
              </RequirePermission>
            </RequireAuth>
          }
        />
        {/* Former standalone pages — kept as redirects so bookmarks and links keep working. */}
        <Route path="/agent-packages" element={<Navigate to="/onboarding?tab=packages" replace />} />
        <Route path="/deployment" element={<Navigate to="/onboarding?tab=tokens" replace />} />
        <Route path="/enrollment-bootstrap" element={<Navigate to="/onboarding?tab=installer" replace />} />
        <Route
          path="/inventory"
          element={
            <RequireAuth>
              <RequirePermission perm="view_inventory">
                <Inventory />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/operators"
          element={
            <RequireAuth>
              <RequirePermission perm="manage_operators">
                <Operators />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/teams"
          element={
            <RequireAuth>
              <RequirePermission perm="manage_teams">
                <Teams />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/teams/:id"
          element={
            <RequireAuth>
              <RequirePermission perm="manage_teams">
                <TeamDetailPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAuth>
              <RequirePermission perm="audit_log">
                <Audit />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/agent-config"
          element={
            <RequireAuth>
              <RequirePermission perm="system_settings">
                <AgentConfigPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/vault"
          element={
            <RequireAuth>
              <RequirePermission perm="system_settings">
                <RequireFeature flag="FEATURE_VAULT">
                  <CredentialVault />
                </RequireFeature>
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/notifications"
          element={
            <RequireAuth>
              <RequirePermission perm="system_settings">
                <RequireFeature flag="FEATURE_NOTIFICATIONS">
                  <NotificationSettings />
                </RequireFeature>
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/reports"
          element={
            <RequireAuth>
              <RequirePermission perm="view_devices">
                <RequireFeature flag="FEATURE_REPORTING">
                  <Reports />
                </RequireFeature>
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/alerts"
          element={
            <RequireAuth>
              <Alerts />
            </RequireAuth>
          }
        />
        <Route
          path="/more"
          element={
            <RequireAuth>
              <More />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <Settings />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <RequireAuth>
              <NotFound />
            </RequireAuth>
          }
        />
      </Routes>
    </Suspense>
  );
}
