import type { ComponentType } from "react";
import {
  Bell,
  BellRing,
  Building2,
  ClipboardList,
  FileBarChart,
  Folder,
  Home,
  PackagePlus,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  UsersRound,
} from "lucide-react";
import type { PlatformFeatureFlag } from "../routes/guards";

/**
 * The single source of truth for app navigation. The desktop sidebar, the
 * top-bar breadcrumb, the mobile More screen, the mobile title bar and the
 * bottom-nav "More" highlight all read from here, so a page is added,
 * renamed or re-grouped in exactly one place.
 */

export type NavBadge = "devices" | "alerts";

/** Where an item lives on mobile: a bottom-nav tab, a More row, or a dimmed desktop-only More row. */
export type MobilePlacement = "tab" | "workspace" | "desktop";

export interface NavItem {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  /** null = every signed-in operator. */
  permission: string | null;
  feature?: PlatformFeatureFlag;
  badge?: NavBadge;
  mobile: MobilePlacement;
  /** Extra words the global search matches on (synonyms, what the page contains). */
  keywords?: string;
}

export interface NavSection {
  id: string;
  /** null renders the section without a heading (the primary group). */
  label: string | null;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "operate",
    label: null,
    items: [
      { label: "Dashboard", to: "/", icon: Home, permission: null, mobile: "tab", keywords: "home overview kpi fleet health system status" },
      { label: "Devices", to: "/devices", icon: Folder, permission: "view_devices", badge: "devices", mobile: "tab", keywords: "endpoints computers servers workstations fleet pc" },
      { label: "Alerts", to: "/alerts", icon: BellRing, permission: null, badge: "alerts", mobile: "tab", keywords: "incidents notifications offline critical warnings" },
      { label: "Remote Support", to: "/remote-support", icon: Radio, permission: null, mobile: "workspace", keywords: "rustdesk connect remote desktop session" },
    ],
  },
  {
    id: "deploy",
    label: "Deploy",
    items: [
      { label: "Onboarding", to: "/onboarding", icon: PackagePlus, permission: "deployment", mobile: "desktop", keywords: "deploy deployment enroll enrollment install agent token package msi gpo" },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    items: [
      { label: "Reports", to: "/reports", icon: FileBarChart, permission: "view_devices", feature: "FEATURE_REPORTING", mobile: "workspace", keywords: "pdf csv export schedule report" },
      { label: "Audit Log", to: "/audit", icon: ClipboardList, permission: "audit_log", mobile: "workspace", keywords: "history activity security compliance log" },
    ],
  },
  {
    id: "organization",
    label: "Organization",
    items: [
      { label: "Clients", to: "/clients", icon: Building2, permission: "manage_clients", mobile: "workspace", keywords: "customers companies organizations groups domain mapping" },
      { label: "Operators", to: "/operators", icon: Users, permission: "manage_operators", mobile: "desktop", keywords: "users technicians accounts roles permissions access" },
      { label: "Teams", to: "/teams", icon: UsersRound, permission: "manage_teams", mobile: "desktop", keywords: "groups access scope" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    items: [
      { label: "Agent Config", to: "/agent-config", icon: SlidersHorizontal, permission: "system_settings", mobile: "desktop", keywords: "heartbeat interval policy bulk commands command center rollout" },
      { label: "Notifications", to: "/notifications", icon: Bell, permission: "system_settings", feature: "FEATURE_NOTIFICATIONS", mobile: "desktop", keywords: "email smtp webhook channels rules" },
      { label: "Credential Vault", to: "/vault", icon: ShieldCheck, permission: "system_settings", feature: "FEATURE_VAULT", mobile: "desktop", keywords: "passwords secrets credentials" },
    ],
  },
];

export interface SearchDestination {
  label: string;
  /** Breadcrumb-style context shown under the label. */
  context: string;
  to: string;
  keywords?: string;
}

/**
 * Places inside pages (tabs, filtered views, sections) the global search can
 * jump straight to. Visibility follows the nav item that owns the path.
 */
export const SEARCH_DESTINATIONS: SearchDestination[] = [
  { label: "Offline devices", context: "Devices", to: "/devices?filter=offline", keywords: "down unreachable not responding" },
  { label: "Critical health", context: "Devices", to: "/devices?filter=critical", keywords: "unhealthy problems" },
  { label: "Needs updates", context: "Devices", to: "/devices?filter=needs_updates", keywords: "patches windows update" },
  { label: "Agent update needed", context: "Devices", to: "/devices?filter=needs_agent_update", keywords: "outdated agent version" },
  { label: "Starred devices", context: "Devices", to: "/devices?filter=favorites", keywords: "favorites my devices" },
  { label: "Packages", context: "Onboarding", to: "/onboarding?tab=packages", keywords: "msi upload agent binary bridge remote support package" },
  { label: "Tokens & commands", context: "Onboarding", to: "/onboarding?tab=tokens", keywords: "enrollment token gpo manual command deploy" },
  { label: "Installer", context: "Onboarding", to: "/onboarding?tab=installer", keywords: "powershell script bootstrap one-click trusted domain" },
  { label: "Heartbeat policy", context: "Agent Config", to: "/agent-config", keywords: "interval inventory threshold" },
  { label: "Command center", context: "Agent Config", to: "/agent-config", keywords: "bulk commands ping restart reboot powershell" },
  { label: "Channels & rules", context: "Notifications", to: "/notifications", keywords: "email smtp webhook alert routing" },
  { label: "Appearance", context: "Settings", to: "/settings", keywords: "theme dark light system" },
  { label: "Account", context: "Settings", to: "/settings", keywords: "profile password email" },
  { label: "Connect defaults", context: "Settings", to: "/settings", keywords: "remote support method preference" },
];

/** Reachable pages that are deliberately not in the sidebar. */
const OTHER_PAGES: Record<string, { section: string; label: string }> = {
  "/settings": { section: "Account", label: "Settings" },
  "/more": { section: "", label: "More" },
  "/inventory": { section: "Insights", label: "Inventory" },
};

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

function matches(item: NavItem, pathname: string): boolean {
  return item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(item.to + "/");
}

/** Section and page label for a path, for breadcrumbs and mobile titles. */
export function locateNav(pathname: string): { section: string; label: string } {
  if (OTHER_PAGES[pathname]) return OTHER_PAGES[pathname];
  for (const section of NAV_SECTIONS) {
    const item = section.items.find((i) => matches(i, pathname));
    if (item) return { section: section.label ?? "", label: item.label };
  }
  const base = "/" + pathname.split("/")[1];
  if (OTHER_PAGES[base]) return OTHER_PAGES[base];
  return { section: "", label: "TECHI Connect" };
}

/** Paths that keep the mobile "More" tab highlighted. */
export const MORE_PATHS: string[] = [
  "/more",
  ...Object.keys(OTHER_PAGES).filter((p) => p !== "/more"),
  ...ALL_NAV_ITEMS.filter((i) => i.mobile !== "tab").map((i) => i.to),
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return matches(item, pathname);
}
