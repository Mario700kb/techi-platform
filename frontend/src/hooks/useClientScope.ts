import { useCallback, useEffect, useRef, useState } from "react";

import { getRecentActions, RemoteActionWithDevice } from "../api/actions";
import { ClientProfile, getClientProfile } from "../api/clients";
import { Device, FleetInsights, getDevices, getFleetInsights } from "../api/devices";

export interface ClientScopeData {
  clientId: number;
  profile: ClientProfile | null;
  devices: Device[] | null;
  actions: RemoteActionWithDevice[] | null;
  insights: FleetInsights | null;
  failed: { profile: boolean; devices: boolean; actions: boolean; insights: boolean };
}

const LISTS_LIMIT = 50;
/** Counts and lists: as often as the fleet-wide dashboard polls them. */
const POLL_MS = 60_000;
/** The server recomputes trends every 30 minutes. */
const INSIGHTS_MS = 30 * 60_000;

function empty(clientId: number): ClientScopeData {
  return {
    clientId,
    profile: null,
    devices: null,
    actions: null,
    insights: null,
    failed: { profile: false, devices: false, actions: false, insights: false },
  };
}

/**
 * The dashboard's data for one client: its profile (counts, health, alerts),
 * newest enrollments and actions, and trends. Null for the whole fleet.
 * Each part shows as soon as its own request returns; a client switched away
 * from never overwrites the one chosen after it.
 */
export function useClientScope(clientId: number | null): { data: ClientScopeData | null; reload: () => void } {
  const [data, setData] = useState<ClientScopeData | null>(() => (clientId == null ? null : empty(clientId)));
  const current = useRef(clientId);
  const insightsAt = useRef(0);

  const load = useCallback((id: number, withInsights: boolean) => {
    const set = (patch: (prev: ClientScopeData) => Partial<ClientScopeData>) =>
      setData((prev) => (prev && prev.clientId === id && current.current === id ? { ...prev, ...patch(prev) } : prev));
    const fail = (key: keyof ClientScopeData["failed"]) => () =>
      set((prev) => ({ failed: { ...prev.failed, [key]: true } }));
    const ok = (key: keyof ClientScopeData["failed"]) => (prev: ClientScopeData) => ({
      failed: { ...prev.failed, [key]: false },
    });
    getClientProfile(id)
      .then((profile) => set((prev) => ({ profile, ...ok("profile")(prev) })))
      .catch(fail("profile"));
    getDevices({ client_id: id }, 0, LISTS_LIMIT)
      .then((page) => set((prev) => ({ devices: page.devices, ...ok("devices")(prev) })))
      .catch(fail("devices"));
    getRecentActions(LISTS_LIMIT, id)
      .then((actions) => set((prev) => ({ actions, ...ok("actions")(prev) })))
      .catch(fail("actions"));
    if (withInsights) {
      insightsAt.current = Date.now();
      getFleetInsights(30, id)
        .then((insights) => set((prev) => ({ insights, ...ok("insights")(prev) })))
        .catch(fail("insights"));
    }
  }, []);

  useEffect(() => {
    current.current = clientId;
    if (clientId == null) {
      setData(null);
      return;
    }
    setData(empty(clientId));
    load(clientId, true);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load(clientId, Date.now() - insightsAt.current >= INSIGHTS_MS);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [clientId, load]);

  const reload = useCallback(() => {
    if (current.current != null) load(current.current, true);
  }, [load]);

  return { data, reload };
}
