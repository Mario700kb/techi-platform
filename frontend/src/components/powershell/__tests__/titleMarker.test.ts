import { describe, expect, it } from "vitest";
import {
  applySent,
  applyTitle,
  commandHistory,
  EMPTY_LOG,
  parseTitleMarker,
  scriptName,
  visibleCommands,
} from "../titleMarker";

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

const title = (id: number, command: string, failed = 0, ms = 12, version = "5.1.19041.4648") =>
  `techi;${version};${id};${failed};${ms};${b64(command)}`;

describe("parseTitleMarker", () => {
  it("reads a finished command", () => {
    expect(parseTitleMarker(title(3, "Get-Service spooler"))).toEqual({
      version: "5.1.19041.4648",
      historyId: 3,
      failed: false,
      durationMs: 12,
      command: "Get-Service spooler",
    });
  });

  it("reads the first prompt (history id 0, no command)", () => {
    expect(parseTitleMarker("techi;7.4.6;0;0;0;")).toEqual({
      version: "7.4.6",
      historyId: 0,
      failed: false,
      durationMs: 0,
      command: "",
    });
  });

  it("reads a failed command", () => {
    const m = parseTitleMarker(title(4, "Get-Item C:\\nope", 1, 3456));
    expect(m?.failed).toBe(true);
    expect(m?.durationMs).toBe(3456);
  });

  it("decodes a unicode command as UTF-8", () => {
    const command = 'Write-Host "Përshëndetje 👋 — ünïcödé"\nGet-Date';
    expect(parseTitleMarker(title(5, command))?.command).toBe(command);
  });

  it("ignores anything that is not a TECHI marker", () => {
    for (const garbage of [
      "",
      "Administrator: Windows PowerShell",
      "techi",
      "techi;5.1;1;0;12",
      "techi;5.1;1;0;12;aGk=;extra",
      "TECHI;5.1;1;0;12;aGk=",
      "techi;5.1;-1;0;12;aGk=",
      "techi;5.1;1;2;12;aGk=",
      "techi;5.1;1;0;1.5;aGk=",
      "techi;;1;0;12;aGk=",
      "techi;5.1;x;0;12;aGk=",
      "techi;5.1;1;0;12;not base64!",
      "techi;5.1;1;0;12;aGk",
      // Valid base64, invalid UTF-8.
      `techi;5.1;1;0;12;${btoa("\xff\xfe\xfd")}`,
    ]) {
      expect(parseTitleMarker(garbage), garbage).toBeNull();
    }
  });
});

describe("command log", () => {
  it("lists each new history id once, with failures and the version", () => {
    let log = applyTitle(EMPTY_LOG, "techi;5.1.19041.4648;0;0;0;", 1_000);
    expect(log.reported).toBe(true);
    expect(log.version).toBe("5.1.19041.4648");
    expect(visibleCommands(log)).toEqual([]);

    log = applyTitle(log, title(1, "hostname", 0, 40), 10_000);
    log = applyTitle(log, title(1, "hostname", 0, 40), 11_000); // same id again: empty Enter
    log = applyTitle(log, title(2, "Get-Item nope", 1, 5), 12_000);
    log = applyTitle(log, "my own title", 13_000);
    const list = visibleCommands(log);
    expect(list.map((c) => [c.label, c.failed, c.durationMs, c.at])).toEqual([
      ["hostname", false, 40, 9_960],
      ["Get-Item nope", true, 5, 11_995],
    ]);
  });

  it("names saved-script runs", () => {
    const line =
      "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SGk='))))  # TECHI script: Clear print queue v3";
    expect(scriptName(line)).toBe("Clear print queue");
    expect(scriptName("Get-Process")).toBeNull();
    const log = applyTitle(EMPTY_LOG, title(1, line));
    expect(visibleCommands(log)[0]).toMatchObject({ label: "Script · Clear print queue", script: true });
    expect(commandHistory(log)).toEqual([]);
  });

  it("falls back to what was sent when the agent reports nothing (2.1.29)", () => {
    let log = applySent(EMPTY_LOG, "ipconfig");
    log = applySent(log, "ipconfig");
    log = applySent(log, "& (...)  # TECHI script: Flush DNS v1", "Script · Flush DNS");
    log = applySent(log, "whoami");
    expect(log.reported).toBe(false);
    expect(visibleCommands(log).map((c) => [c.label, c.failed])).toEqual([
      ["ipconfig", null],
      ["ipconfig", null],
      ["Script · Flush DNS", null],
      ["whoami", null],
    ]);
    expect(commandHistory(log)).toEqual(["ipconfig", "whoami"]);
  });
});
