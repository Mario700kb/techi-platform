import { Route, Routes } from "react-router-dom";
import Dashboard from "../pages/Dashboard";
import Devices from "../pages/Devices";
import Inventory from "../pages/Inventory";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/devices" element={<Devices />} />
      <Route path="/inventory" element={<Inventory />} />
    </Routes>
  );
}
