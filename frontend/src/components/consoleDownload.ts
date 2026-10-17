import { getConsoleRecording } from "../api/terminal";

/** Hand an asciicast recording to the browser as a .cast file. */
export function saveCast(text: string, sessionId: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-asciicast" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `powershell-${sessionId}.cast`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadConsoleRecording(deviceId: number, sessionId: string): Promise<void> {
  saveCast(await getConsoleRecording(deviceId, sessionId), sessionId);
}
