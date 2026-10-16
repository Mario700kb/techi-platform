import { Suspense } from "react";
import AppShell from "./layouts/AppShell";
import AppRoutes from "./routes/AppRoutes";
import { useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import AppPreloader from "./components/AppPreloader";
import ErrorBoundary from "./components/ErrorBoundary";
import MfaEnrollment from "./pages/MfaEnrollment";
import { RouteFallback } from "./routes/pageLoading";

function App() {
  const location = useLocation();
  const { loading, user, mfaEnrollmentRequired } = useAuth();
  // Routes that own the whole viewport: login, and the standalone terminal
  // window opened from the Device Catalog. Rendering the sidebar and topbar
  // inside a 1024x640 popup would leave the terminal a fraction of it.
  const isChromeless = location.pathname === "/login" || location.pathname.startsWith("/terminal/");
  // A stored token without a cached user is verified before any chrome is
  // drawn, so the shell never flashes in for someone about to be signed out.
  if (loading && location.pathname !== "/login") {
    return <AppPreloader />;
  }
  // Keyed on the path so a crashed page clears itself on navigation while
  // the sidebar and top bar stay usable.
  const routes = (
    <ErrorBoundary resetKey={location.pathname}>
      <AppRoutes />
    </ErrorBoundary>
  );
  // The role requires 2FA and it is not set up: the API answers nothing
  // else until it is, so the setup replaces the whole console.
  if (user && mfaEnrollmentRequired && location.pathname !== "/login") {
    return (
      <ErrorBoundary scope="app">
        <MfaEnrollment />
      </ErrorBoundary>
    );
  }
  if (isChromeless) {
    return <Suspense fallback={<RouteFallback />}>{routes}</Suspense>;
  }
  return <AppShell>{routes}</AppShell>;
}

export default App;
