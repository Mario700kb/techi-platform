import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
// The sign-in screen and the Dashboard are what nearly every visit starts
// on, so they ship in the main bundle; every other page is its own chunk,
// prefetched once the first page has shown (see pageLoading.tsx).
import Dashboard from "../pages/Dashboard";
import Login from "../pages/Login";
import { NotFound } from "../pages/StatusPages";
import { RequireAuth, RequireFeature, RequirePermission } from "./guards";
import { FirstPageShown, pageLoaders } from "./pageLoading";

const Devices = lazy(pageLoaders.Devices);
const Clients = lazy(pageLoaders.Clients);
const ClientProfilePage = lazy(pageLoaders.ClientProfile);
const Audit = lazy(pageLoaders.Audit);
const Onboarding = lazy(pageLoaders.Onboarding);
const Inventory = lazy(pageLoaders.Inventory);
const Operators = lazy(pageLoaders.Operators);
const Reenrollment = lazy(pageLoaders.Reenrollment);
const Teams = lazy(pageLoaders.Teams);
const TeamDetailPage = lazy(pageLoaders.TeamDetail);
const AgentConfigPage = lazy(pageLoaders.AgentConfig);
const Alerts = lazy(pageLoaders.Alerts);
const More = lazy(pageLoaders.More);
const Settings = lazy(pageLoaders.Settings);
const DeviceDetailsMobile = lazy(pageLoaders.DeviceDetailsMobile);
const TerminalWindow = lazy(pageLoaders.TerminalWindow);
const CredentialVault = lazy(pageLoaders.CredentialVault);
const NotificationSettings = lazy(pageLoaders.NotificationSettings);
const Reports = lazy(pageLoaders.Reports);

export default function AppRoutes() {
  // The Suspense boundary for these pages sits above them (App for the
  // chromeless routes, AppShell for the rest), outside the per-path <main>, so
  // a navigation keeps the current page on screen until the next one is ready.
  return (
    <>
      <FirstPageShown />
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
          path="/reenrollment"
          element={
            <RequireAuth>
              <RequirePermission perm="manage_operators">
                <Reenrollment />
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
        {/* A client's profile: anyone who can see devices; the API limits it to
            the part of the client the operator's teams grant. */}
        <Route
          path="/clients/:id"
          element={
            <RequireAuth>
              <RequirePermission perm="view_devices">
                <ClientProfilePage />
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
    </>
  );
}
