/** A command handed from the alert panel to the administrator PowerShell
 * window: kept in this browser for five minutes, read once, typed into the
 * command bar and never run by itself. */
const PREFILL_KEY = (deviceId: number) => `techi.ps.prefill.${deviceId}`;

/** Opens the administrator PowerShell window with a command typed in the
 * command bar, not run: the technician reads it and presses Enter. */
export function openPowerShellWith(deviceId: number, deviceName: string, script: string): void {
  try {
    window.localStorage.setItem(PREFILL_KEY(deviceId), JSON.stringify({ script, at: Date.now() }));
  } catch {
    /* without storage the window opens empty; the command is still copyable */
  }
  window.open(
    `/terminal/${deviceId}?engine=powershell&prefill=1&name=${encodeURIComponent(deviceName)}`,
    `techi-powershell-${deviceId}`,
    "popup,width=1100,height=720",
  );
}

/** The command left for this device by "Open in PowerShell", once, if recent. */
export function takePowerShellPrefill(deviceId: number): string | null {
  try {
    const raw = window.localStorage.getItem(PREFILL_KEY(deviceId));
    if (!raw) return null;
    window.localStorage.removeItem(PREFILL_KEY(deviceId));
    const parsed = JSON.parse(raw) as { script?: string; at?: number };
    if (!parsed.script || !parsed.at || Date.now() - parsed.at > 5 * 60_000) return null;
    return parsed.script;
  } catch {
    return null;
  }
}
