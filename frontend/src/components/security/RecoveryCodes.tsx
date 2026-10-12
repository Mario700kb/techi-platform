import { useState } from "react";
import type { CSSProperties } from "react";
import { Check, Copy, Download, TriangleAlert } from "lucide-react";
import Button from "../ui/Button";
import { saveBlob } from "../../utils/download";

/** Shows freshly issued recovery codes once, with copy and download. */
export default function RecoveryCodes({ codes, account }: { codes: string[]; account: string }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the codes stay visible to copy by hand.
    }
  };

  const download = () => {
    const header = `TECHI Connect recovery codes for ${account}\nEach code works once. Keep them somewhere safe.\n\n`;
    saveBlob(new Blob([header + text + "\n"], { type: "text/plain" }), "techi-recovery-codes.txt");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as CSSProperties} role="status">
        <TriangleAlert className="h-4 w-4" />
        <span>
          Save these codes now — they are shown only once. Each one signs you in a single time if you lose your phone.
        </span>
      </div>
      <ol
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border px-4 py-3 font-mono text-[13px]"
        style={{
          borderColor: "var(--th-border-default)",
          background: "var(--th-bg-card-soft)",
          color: "var(--th-text-primary)",
        }}
        aria-label="Recovery codes"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" size="sm" onClick={download}>
          <Download className="h-3.5 w-3.5" />
          Download .txt
        </Button>
      </div>
    </div>
  );
}
