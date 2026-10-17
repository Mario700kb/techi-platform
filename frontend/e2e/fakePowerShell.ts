import type { Page } from "@playwright/test";

/**
 * A stand-in for the agent's administrator PowerShell behind the operator
 * websocket: draws the blue TECHI prompt, echoes what it is sent, and after
 * every command sets the title marker agent 2.1.30 sends
 * (`techi;<version>;<history id>;<failed>;<ms>;<base64 command>`).
 * Commands that start with "Get-Item C:\nope" fail.
 */
export const PS_VERSION = "5.1.19041.4648";
const PROMPT = "\x1b[38;2;110;168;254mPS C:\\Windows\\system32> \x1b[0m";
const title = (id: number, failed: boolean, ms: number, command: string) =>
  `\x1b]0;techi;${PS_VERSION};${id};${failed ? 1 : 0};${ms};${Buffer.from(command, "utf8").toString("base64")}\x07`;

export interface FakeShell {
  /** Everything the page typed (resize messages left out). */
  received: string[];
}

export async function fakePowerShell(page: Page, sessionId: string, { reportTitles = true } = {}): Promise<FakeShell> {
  const shell: FakeShell = { received: [] };
  await page.routeWebSocket(new RegExp(`/ws/terminal/${sessionId}`), (ws) => {
    let id = 0;
    let line = "";
    ws.send(PROMPT);
    if (reportTitles) ws.send(title(0, false, 0, ""));
    ws.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString("utf8");
      if (text.startsWith("{")) return; // {"t":"resize",…}
      shell.received.push(text);
      if (text === "\x03") {
        ws.send(`^C\r\n${PROMPT}`);
        line = "";
        return;
      }
      let out = "";
      for (const ch of text) {
        if (ch !== "\r") {
          line += ch;
          out += ch;
          continue;
        }
        const command = line;
        line = "";
        const failed = command.startsWith("Get-Item C:\\nope");
        const output = failed
          ? "\x1b[91mGet-Item : Cannot find path 'C:\\nope' because it does not exist.\x1b[0m\r\n"
          : command
            ? `\x1b[32mRunning\x1b[0m  ${command.slice(0, 40)}\r\n`
            : "";
        id += command ? 1 : 0;
        out += `\r\n${output}${reportTitles ? title(id, failed, failed ? 340 : 12, command) : ""}${PROMPT}`;
      }
      if (out) ws.send(out);
    });
  });
  return shell;
}

/** The session the platform hands out once the two-factor code is right. */
export async function mockPowerShellSession(page: Page, deviceId: number, sessionId: string) {
  await page.route(`**/api/v1/devices/${deviceId}/terminal/sessions`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { engine: string; mfa_code: string };
    if (body.engine !== "powershell" || body.mfa_code !== "123456") {
      return route.fulfill({
        status: 403,
        json: { detail: { code: "mfa_invalid", detail: "Enter a current two-factor code." } },
      });
    }
    const origin = new URL(page.url()).origin.replace(/^http/, "ws");
    return route.fulfill({
      json: {
        session_id: sessionId,
        operator_ws_path: `${origin}/ws/terminal/${sessionId}?ticket=t`,
        operator_ticket: "t",
        expires_in_seconds: 60,
      },
    });
  });
}

export const SCRIPTS = [
  {
    id: 2,
    name: "Flush DNS",
    description: "Clears the DNS resolver cache",
    body: "Clear-DnsClientCache\nWrite-Output 'DNS cache cleared'",
    version: 3,
    uses: 30,
    last_used_at: "2026-10-17T09:00:00Z",
    updated_by: "ana.owner",
    updated_at: "2026-10-16T09:00:00Z",
  },
  {
    id: 4,
    name: "Restart print spooler",
    description: "Stops the spooler, clears stuck jobs, starts it again",
    body: "Stop-Service spooler -Force\nRemove-Item C:\\Windows\\System32\\spool\\PRINTERS\\* -Force\nStart-Service spooler",
    version: 1,
    uses: 12,
    last_used_at: null,
    updated_by: "besi.ops",
    updated_at: "2026-10-15T09:00:00Z",
  },
  {
    id: 5,
    name: "Disk usage",
    description: "Free space per fixed drive",
    body: "Get-PSDrive -PSProvider FileSystem",
    version: 2,
    uses: 7,
    last_used_at: null,
    updated_by: "ana.owner",
    updated_at: "2026-10-14T09:00:00Z",
  },
];

export async function mockScripts(page: Page) {
  await page.route("**/api/v1/console/scripts", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: SCRIPTS }) : route.fallback(),
  );
}
