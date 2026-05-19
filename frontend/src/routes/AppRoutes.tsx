import { Route, Routes } from "react-router-dom";
import { Navigate, useLocation } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import Dashboard from "../pages/Dashboard";
import Devices from "../pages/Devices";
import Clients from "../pages/Clients";
import Audit from "../pages/Audit";
import AgentPackages from "../pages/AgentPackages";
import EnrollmentBootstrap from "../pages/EnrollmentBootstrap";
import Inventory from "../pages/Inventory";
import Operators from "../pages/Operators";
import Login from "../pages/Login";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-4 text-sm font-medium text-slate-400">Loading session...</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { can, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-4 text-sm font-medium text-slate-400">Loading session...</div>;
  if (!can("admin")) return <Navigate to="/" replace state={{ from: location }} />;
  return <>{children}</>;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/devices" element={<RequireAuth><Devices /></RequireAuth>} />
      <Route path="/clients" element={<RequireAuth><Clients /></RequireAuth>} />
      <Route path="/enrollment-bootstrap" element={<RequireAuth><EnrollmentBootstrap /></RequireAuth>} />
      <Route path="/agent-packages" element={<RequireAuth><AgentPackages /></RequireAuth>} />
      <Route path="/inventory" element={<RequireAuth><Inventory /></RequireAuth>} />
      <Route path="/operators" element={<RequireAuth><RequireAdmin><Operators /></RequireAdmin></RequireAuth>} />
      <Route path="/audit" element={<RequireAuth><RequireAdmin><Audit /></RequireAdmin></RequireAuth>} />
    </Routes>
  );
}
