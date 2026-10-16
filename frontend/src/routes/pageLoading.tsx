import { useEffect } from "react";
import AppPreloader from "../components/AppPreloader";

// Every page except the Dashboard and sign-in is its own chunk. They are
// listed here once so the routes and the prefetch below share the same
// import() calls, which the bundler and the browser load only once.
export const pageLoaders = {
  Devices: () => import("../pages/Devices"),
  Clients: () => import("../pages/Clients"),
  ClientProfile: () => import("../pages/ClientProfile"),
  Audit: () => import("../pages/Audit"),
  Onboarding: () => import("../pages/Onboarding"),
  Inventory: () => import("../pages/Inventory"),
  Operators: () => import("../pages/Operators"),
  Reenrollment: () => import("../pages/Reenrollment"),
  Teams: () => import("../pages/Teams"),
  TeamDetail: () => import("../pages/TeamDetail"),
  AgentConfig: () => import("../pages/AgentConfig"),
  Alerts: () => import("../pages/Alerts"),
  More: () => import("../pages/More"),
  Settings: () => import("../pages/Settings"),
  DeviceDetailsMobile: () => import("../pages/DeviceDetailsMobile"),
  TerminalWindow: () => import("../pages/TerminalWindow"),
  CredentialVault: () => import("../pages/CredentialVault"),
  NotificationSettings: () => import("../pages/NotificationSettings"),
  Reports: () => import("../pages/Reports"),
};

// The terminal popup is opened rarely and pulls in the terminal emulator.
const NOT_PREFETCHED = new Set<keyof typeof pageLoaders>(["TerminalWindow"]);

// Once the first page is on screen, fetch the other pages' code while the
// browser is idle (~170 KB gzipped), so moving between pages does not wait
// for the network — also on the first visit after a deploy renames every chunk.
function prefetchPages(): void {
  const run = () => {
    for (const [name, load] of Object.entries(pageLoaders)) {
      if (!NOT_PREFETCHED.has(name as keyof typeof pageLoaders)) load().catch(() => undefined);
    }
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 3000 });
  else window.setTimeout(run, 1500);
}

// After a reload the page's own code is still on its way when the shell can
// already draw. Until the first page has shown, keep the full-screen preloader
// the boot screen started — the same animation, so it simply stays — instead
// of an empty shell with a bar.
let firstPageShown = false;

export function FirstPageShown() {
  useEffect(() => {
    if (firstPageShown) return;
    firstPageShown = true;
    prefetchPages();
  }, []);
  return null;
}

export function RouteFallback() {
  return firstPageShown ? <AppPreloader inline label="Loading" /> : <AppPreloader />;
}
