import { DESKTOP_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import AlertsDesktop from "./AlertsDesktop";
import AlertsMobile from "./AlertsMobile";

// Desktop gets a dense, filterable table; below md the Mobile UI 2.0 cards
// stay. Only one is mounted, so the alerts are fetched once.
export default function Alerts() {
  return useMediaQuery(DESKTOP_QUERY) ? <AlertsDesktop /> : <AlertsMobile />;
}
