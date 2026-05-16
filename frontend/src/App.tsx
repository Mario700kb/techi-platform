import AppShell from "./layouts/AppShell";
import AppRoutes from "./routes/AppRoutes";
import { useLocation } from "react-router-dom";

function App() {
  const location = useLocation();
  if (location.pathname === "/login") {
    return <AppRoutes />;
  }
  return (
    <AppShell>
      <AppRoutes />
    </AppShell>
  );
}

export default App;
