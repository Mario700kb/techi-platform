import AppShell from "./layouts/AppShell";
import AppRoutes from "./routes/AppRoutes";
import { useLocation } from "react-router-dom";

function App() {
  const location = useLocation();
  // Routes that own the whole viewport: login, and the standalone terminal
  // window opened from the Device Catalog. Rendering the sidebar and topbar
  // inside a 1024x640 popup would leave the terminal a fraction of it.
  const isChromeless =
    location.pathname === "/login" || location.pathname.startsWith("/terminal/");
  if (isChromeless) {
    return <AppRoutes />;
  }
  return (
    <AppShell>
      <AppRoutes />
    </AppShell>
  );
}

export default App;
