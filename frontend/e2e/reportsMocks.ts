/**
 * The report API for the Reports page: the client catalog, an on-screen
 * preview per report (a realistic executive summary and hardware lifecycle
 * for Northwind), generation, runs and schedules. Typed against the app's
 * own API types so a contract change breaks the e2e typecheck.
 */
import type { Page, Request } from "@playwright/test";
import type {
  ClientReportKey,
  GenerateReportPayload,
  ReportCatalogEntry,
  ReportClient,
  ReportDocument,
  ReportRun,
  ReportSchedule,
} from "../src/api/reports";

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const day = (daysFromNow: number): string => new Date(NOW + daysFromNow * 86_400_000).toISOString().slice(0, 10);

export const REPORT_CLIENTS: ReportClient[] = [
  { id: 1, name: "Northwind Clinic" },
  { id: 2, name: "Blue Harbor Logistics" },
];

/** The server's catalog (backend/app/services/client_reports/catalog.py). */
export const CATALOG: ReportCatalogEntry[] = [
  {
    key: "executive",
    title: "Executive summary",
    description:
      "The monthly summary for the client: headline numbers from every report, the top issues and plain recommendations.",
    formats: ["pdf"],
    needs: null,
    preview: true,
  },
  {
    key: "patch_compliance",
    title: "Patch compliance",
    description: "Devices with pending Windows updates, waiting for a restart or not updated for 30 days or more.",
    formats: ["pdf", "csv"],
    needs: null,
    preview: true,
  },
  {
    key: "lifecycle",
    title: "OS lifecycle & hardware",
    description:
      "Operating systems past or near Microsoft's end of support, and devices with too little memory or disk.",
    formats: ["pdf", "csv"],
    needs: null,
    preview: true,
  },
  {
    key: "availability",
    title: "Availability & outages",
    description: "How long servers were online (24/7) and workstations during working hours, with every server outage.",
    formats: ["pdf", "csv"],
    needs: null,
    preview: true,
  },
  {
    key: "capacity",
    title: "Disk capacity",
    description: "Full disks now and disks forecast to reach 90% from their growth.",
    formats: ["pdf", "csv"],
    needs: null,
    preview: true,
  },
  {
    key: "access_audit",
    title: "Access audit",
    description:
      "Who connected to which device and for how long: Remote Support, PowerShell, terminal and SSH sessions, " +
      "scripts run, refused logins and revealed credentials.",
    formats: ["pdf", "csv"],
    needs: null,
    preview: true,
  },
  {
    key: "security_posture",
    title: "Security posture",
    description:
      "Antivirus, firewall, BitLocker, UAC, Secure Boot and local administrators on every device, with a score.",
    formats: ["pdf", "csv"],
    needs: "agent 2.1.31",
    preview: true,
  },
  {
    key: "full",
    title: "Full fleet report",
    description: "The fleet summary, device inventory and alert activity of the period (the original client report).",
    formats: ["pdf", "csv"],
    needs: null,
    preview: false,
  },
];

function period(url: URL) {
  const days = Number(url.searchParams.get("period_days") || 30);
  const end = url.searchParams.get("period_to") ?? new Date(NOW).toISOString();
  const start = url.searchParams.get("period_from") ?? new Date(NOW - days * 86_400_000).toISOString();
  return { period_start: start, period_end: end };
}

const clientOf = (url: URL) =>
  REPORT_CLIENTS.find((c) => c.id === Number(url.searchParams.get("client_id"))) ?? REPORT_CLIENTS[0];

/** Shaped like backend/app/services/client_reports/executive.py, before any device runs agent 2.1.31. */
export function executiveDocument(url: URL): ReportDocument {
  const client = clientOf(url);
  return {
    key: "executive",
    title: "Executive summary",
    subtitle: "The headline of every report, the top issues and what to do next",
    client_id: client.id,
    client_name: client.name,
    ...period(url),
    generated_at: iso(1),
    summary: [
      { label: "Patch compliance", value: 87.5, kind: "percent", tone: "warn", hint: "42 of 48 devices up to date" },
      { label: "Server availability", value: 99.95, kind: "percent", tone: "ok", hint: "1 outages" },
      { label: "Unsupported OS", value: 3, kind: "number", tone: "crit", hint: "2 more within 12 months" },
      { label: "Disks at risk", value: 1, kind: "number", tone: "crit", hint: "90%+ full; 2 more within 30 days" },
      { label: "Remote sessions", value: 64, kind: "number", tone: "neutral", hint: "31h 20m in total by 4 operators" },
      {
        label: "Security: protected",
        value: "needs agent 2.1.31",
        kind: "text",
        tone: "info",
        hint: "No device reports its security settings yet",
      },
    ],
    sections: [
      {
        key: "top_issues",
        title: "Top issues",
        description: "The most serious findings of every report.",
        columns: [
          { key: "severity", label: "Severity", align: "left", kind: "badge" },
          { key: "issue", label: "Issue", align: "left", kind: "text" },
          { key: "area", label: "Report", align: "left", kind: "text" },
        ],
        rows: [
          {
            severity: "Critical",
            issue: "3 devices on Windows 10, unsupported since 14 Oct 2025",
            area: "OS lifecycle & hardware",
            _tone: "crit",
          },
          {
            severity: "Critical",
            issue: "NW-SRV-01 D: is 94% full",
            area: "Disk capacity",
            _tone: "crit",
          },
          {
            severity: "Warning",
            issue: "6 devices have not installed updates for 30 days or more",
            area: "Patch compliance",
            _tone: "warn",
          },
          {
            severity: "Info",
            issue: "2 devices with less than 8 GB RAM",
            area: "OS lifecycle & hardware",
            _tone: "info",
          },
        ],
        empty: "No issues found.",
      },
      {
        key: "recommendations",
        title: "Recommendations",
        description: "What to do next, most important first.",
        columns: [
          { key: "n", label: "#", align: "right", kind: "number" },
          { key: "recommendation", label: "Recommendation", align: "left", kind: "text" },
        ],
        rows: [
          {
            n: 1,
            recommendation:
              "Replace or upgrade the 3 devices on Windows 10 (unsupported since 14 Oct 2025); they no longer " +
              "receive security updates and are the largest risk in this fleet.",
          },
          { n: 2, recommendation: "Free space on NW-SRV-01 D: or extend the volume before it fills." },
          { n: 3, recommendation: "Restart the 4 devices waiting for a restart to finish their updates." },
        ],
        empty: "Nothing to recommend: keep the current routine.",
      },
      {
        key: "areas",
        title: "Areas",
        description: "The headline of each detailed report.",
        columns: [
          { key: "area", label: "Report", align: "left", kind: "text" },
          { key: "headline", label: "Measure", align: "left", kind: "text" },
          { key: "value", label: "Value", align: "right", kind: "text" },
          { key: "status", label: "Status", align: "left", kind: "badge" },
        ],
        rows: [
          { area: "Patch compliance", headline: "Compliance", value: "87.5%", status: "Review", _tone: "warn" },
          { area: "Availability & outages", headline: "Servers online", value: "99.95%", status: "OK", _tone: "ok" },
          {
            area: "OS lifecycle & hardware",
            headline: "Unsupported OS",
            value: "3",
            status: "Action needed",
            _tone: "crit",
          },
          { area: "Disk capacity", headline: "Disks at risk", value: "1", status: "Action needed", _tone: "crit" },
          { area: "Access audit", headline: "Remote sessions", value: "64", status: "OK", _tone: "ok" },
          { area: "Security posture", headline: "Protected", value: "—", status: "No data", _tone: "neutral" },
        ],
        empty: "—",
      },
    ],
    notes: ["Each area has its own detailed report with the device lists behind these figures."],
  };
}

/** Shaped like backend/app/services/client_reports/lifecycle.py: rows carry extra keys no column lists. */
export function lifecycleDocument(url: URL): ReportDocument {
  const client = clientOf(url);
  const cells = (id: number, device: string, os: string) => ({ device, os, _device_id: id });
  return {
    key: "lifecycle",
    title: "OS lifecycle & hardware",
    subtitle: "Support status as of 17 Oct 2026",
    client_id: client.id,
    client_name: client.name,
    ...period(url),
    generated_at: iso(1),
    summary: [
      {
        label: "Unsupported OS",
        value: 3,
        kind: "number",
        tone: "crit",
        hint: "No more security updates from Microsoft",
      },
      { label: "Support ends within 12 months", value: 2, kind: "number", tone: "warn", hint: "By 17 Oct 2027" },
      {
        label: "Supported",
        value: 93.5,
        kind: "percent",
        tone: "warn",
        hint: "Still receiving updates, of 46 devices with a known OS; 2 unknown",
      },
      {
        label: "RAM under 8 GB",
        value: 2,
        kind: "number",
        tone: "warn",
        hint: "1 device with system disk under 10% free",
      },
    ],
    sections: [
      {
        key: "unsupported",
        title: "Unsupported OS",
        description: "Microsoft no longer ships security updates for these systems.",
        columns: [
          { key: "device", label: "Device", align: "left", kind: "text" },
          { key: "product", label: "Operating system", align: "left", kind: "text" },
          { key: "build", label: "Build", align: "right", kind: "text" },
          { key: "end", label: "Support ended", align: "left", kind: "date" },
          { key: "days_since", label: "Days since", align: "right", kind: "number" },
          { key: "last_seen", label: "Last seen", align: "left", kind: "datetime" },
        ],
        rows: [
          {
            ...cells(2, "NW-DOCTOR-02", "Windows 10 Pro"),
            product: "Windows 10 Pro",
            build: "19045",
            end: "2025-10-14",
            days_since: 368,
            last_seen: iso(60 * 24 * 4),
            _tone: "crit",
          },
          {
            ...cells(1, "NW-RECEPTION-01", "Windows 10 Pro"),
            product: "Windows 10 Pro",
            build: "19045",
            end: "2025-10-14",
            days_since: 368,
            last_seen: iso(3),
            _tone: "crit",
          },
          {
            device: "NW-LAB-03",
            os: "Windows 10 Pro",
            product: "Windows 10 Pro",
            build: "19044",
            end: "2025-10-14",
            days_since: 368,
            last_seen: iso(60 * 30),
            _tone: "crit",
          },
        ],
        empty: "Every device runs a supported operating system.",
      },
      {
        key: "ending_soon",
        title: "Support ending soon",
        description: "Support ends within the next 12 months: plan the upgrade or replacement now.",
        columns: [
          { key: "device", label: "Device", align: "left", kind: "text" },
          { key: "product", label: "Operating system", align: "left", kind: "text" },
          { key: "build", label: "Build", align: "right", kind: "text" },
          { key: "end", label: "Support ends", align: "left", kind: "date" },
          { key: "days_left", label: "Days left", align: "right", kind: "number" },
          { key: "last_seen", label: "Last seen", align: "left", kind: "datetime" },
        ],
        rows: [
          {
            ...cells(3, "NW-SRV-01", "Windows 11 Pro 23H2"),
            product: "Windows 11 Pro 23H2",
            build: "22631",
            end: day(25),
            days_left: 25,
            last_seen: iso(1),
            _tone: "warn",
          },
          {
            device: "NW-NURSE-04",
            os: "Windows 11 Pro 23H2",
            product: "Windows 11 Pro 23H2",
            build: "22631",
            end: day(25),
            days_left: 25,
            last_seen: iso(60 * 2),
            _tone: "warn",
          },
        ],
        empty: "No operating system reaches its end of support in the next 12 months.",
      },
      {
        key: "hardware",
        title: "Low memory or disk space",
        description: "RAM under 8 GB or a system disk with less than 10% free.",
        columns: [
          { key: "device", label: "Device", align: "left", kind: "text" },
          { key: "os", label: "OS", align: "left", kind: "text" },
          { key: "ram_gb", label: "RAM (GB)", align: "right", kind: "number" },
          { key: "disk_free_pct", label: "Disk free", align: "right", kind: "percent" },
          { key: "cpu", label: "CPU", align: "left", kind: "text" },
          { key: "issue", label: "Issue", align: "left", kind: "badge" },
        ],
        rows: [
          {
            ...cells(1, "NW-RECEPTION-01", "Windows 10 Pro"),
            ram_gb: 4,
            disk_free_pct: 7.4,
            disk_free_gb: 17.6,
            cpu: "Intel Core i3-8100",
            issue: "RAM under 8 GB · System disk under 10% free",
            _tone: "warn",
          },
          {
            device: "NW-LAB-03",
            os: "Windows 10 Pro",
            ram_gb: 6,
            disk_free_pct: 41.2,
            disk_free_gb: 98,
            cpu: null,
            issue: "RAM under 8 GB",
            _tone: "warn",
          },
        ],
        empty: "Every device meets the memory and disk baseline.",
        note: "RAM from 7.5 GB counts as 8 GB: Windows reports slightly less than is installed.",
      },
      {
        key: "os_overview",
        title: "OS overview",
        description: "Devices per operating system and the date its support ends.",
        columns: [
          { key: "product", label: "Operating system", align: "left", kind: "text" },
          { key: "status", label: "Status", align: "left", kind: "badge" },
          { key: "end", label: "End of support", align: "left", kind: "date" },
          { key: "count", label: "Devices", align: "right", kind: "number" },
        ],
        rows: [
          { product: "Windows 10 Pro", status: "Unsupported", end: "2025-10-14", count: 3, _tone: "crit" },
          { product: "Windows 11 Pro 23H2", status: "Ends within 12 months", end: day(25), count: 2, _tone: "warn" },
          { product: "Windows 11 Pro 24H2", status: "Supported", end: "2027-10-12", count: 38, _tone: "ok" },
          { product: "Windows Server 2022", status: "Supported", end: "2031-10-14", count: 3, _tone: "ok" },
          { product: "Ubuntu 24.04 LTS", status: "Unknown", end: null, count: 2, _tone: "neutral" },
        ],
        empty: "No devices.",
      },
    ],
    notes: [
      "End-of-support dates: Microsoft lifecycle pages. Windows 10 Extended Security Updates are not tracked.",
      "Unknown: an operating system the table does not cover (Linux, macOS, preview builds).",
    ],
  };
}

function genericDocument(key: ClientReportKey, url: URL): ReportDocument {
  const entry = CATALOG.find((e) => e.key === key)!;
  const client = REPORT_CLIENTS.find((c) => c.id === Number(url.searchParams.get("client_id"))) ?? REPORT_CLIENTS[0];
  return {
    key,
    title: entry.title,
    subtitle: entry.description,
    client_id: client.id,
    client_name: client.name,
    ...period(url),
    generated_at: iso(1),
    summary: [
      { label: "Devices", value: 48, hint: null, tone: "info" },
      { label: "Covered", value: "96%", hint: null, tone: "ok" },
    ],
    sections: [],
    notes: [],
  };
}

export const RUNS: ReportRun[] = [
  {
    id: 101,
    schedule_id: 1,
    client_id: 1,
    client_name: "Northwind Clinic",
    scope_type: "client",
    report_type: "full",
    report_format: "pdf",
    period_start: iso(60 * 24 * 31),
    period_end: iso(60 * 24),
    status: "completed",
    filename: "northwind-full.pdf",
    size_bytes: 284_000,
    generated_by: "scheduler",
    created_at: iso(60 * 24),
    completed_at: iso(60 * 24 - 1),
  },
  {
    id: 102,
    client_id: 2,
    client_name: "Blue Harbor Logistics",
    device_id: 4,
    device_name: "BH-WH-SCANNER",
    scope_type: "device",
    report_type: "alerts",
    report_format: "csv",
    period_start: iso(60 * 24 * 7),
    period_end: iso(60),
    status: "completed",
    filename: "bh-wh-scanner-alerts.csv",
    size_bytes: 3_400,
    generated_by: "ana.owner",
    created_at: iso(60),
    completed_at: iso(59),
  },
];

export const SCHEDULES: ReportSchedule[] = [
  {
    id: 1,
    name: "Northwind monthly",
    client_id: 1,
    client_name: "Northwind Clinic",
    report_type: "executive",
    report_format: "pdf",
    cadence: "monthly",
    period_days: 30,
    hour_local: 8,
    day_of_week: null,
    day_of_month: 1,
    enabled: true,
    next_run_at: new Date(NOW + 9 * 86_400_000).toISOString(),
    last_run_at: iso(60 * 24),
    created_by: "ana.owner",
    created_at: "2026-01-10T09:00:00Z",
    updated_at: "2026-01-10T09:00:00Z",
  },
];

export interface ReportsMock {
  generated: GenerateReportPayload[];
  downloads: number[];
  previews: URL[];
}

/** Installs the report API on top of the app mock (later routes win). */
export async function mockReports(page: Page): Promise<ReportsMock> {
  const state: ReportsMock = { generated: [], downloads: [], previews: [] };
  let nextRun = 200;
  await page.route("**/api/v1/reports/**", async (route) => {
    const request: Request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/\/$/, "");
    if (method === "GET" && path === "/api/v1/reports/catalog") return route.fulfill({ json: CATALOG });
    if (method === "GET" && path === "/api/v1/reports/clients") return route.fulfill({ json: REPORT_CLIENTS });
    if (method === "GET" && path === "/api/v1/reports/runs") return route.fulfill({ json: { items: RUNS, total: 2 } });
    if (method === "GET" && path === "/api/v1/reports/schedules") return route.fulfill({ json: SCHEDULES });
    if (method === "GET" && path === "/api/v1/reports/preview") {
      state.previews.push(url);
      const key = url.searchParams.get("report_type") as ClientReportKey;
      if (key === "full")
        return route.fulfill({ status: 422, json: { detail: "This report has no preview; generate it as a file" } });
      const body =
        key === "executive"
          ? executiveDocument(url)
          : key === "lifecycle"
            ? lifecycleDocument(url)
            : genericDocument(key, url);
      return route.fulfill({ json: body });
    }
    if (method === "POST" && path === "/api/v1/reports/generate") {
      const body = request.postDataJSON() as GenerateReportPayload;
      state.generated.push(body);
      const client = REPORT_CLIENTS.find((c) => c.id === body.client_id) ?? REPORT_CLIENTS[0];
      const id = nextRun++;
      const run: ReportRun = {
        id,
        client_id: client.id,
        client_name: client.name,
        scope_type: "client",
        report_type: body.report_type,
        report_format: body.report_format,
        period_start: iso(60 * 24 * (body.period_days ?? 30)),
        period_end: iso(0),
        status: "completed",
        filename: `${client.name.split(" ")[0].toLowerCase()}-${body.report_type}.${body.report_format}`,
        size_bytes: 120_000,
        generated_by: "ana.owner",
        created_at: iso(0),
        completed_at: iso(0),
      };
      return route.fulfill({ json: run });
    }
    const download = path.match(/^\/api\/v1\/reports\/runs\/(\d+)\/download$/);
    if (method === "GET" && download) {
      state.downloads.push(Number(download[1]));
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%mock\n" });
    }
    return route.fulfill({ status: 404, json: { detail: "Not mocked" } });
  });
  return state;
}
