import { useEffect, useRef, useState } from "react";
import { CheckCircle, ClipboardCopy } from "lucide-react";

/** Copies `text`; a check shows for a moment once it is on the clipboard. */
export default function CopyButton({
  text,
  label,
  className = "",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className={`th-icon-btn th-icon-btn-ghost ${className}`.trim()}
      data-copied={copied || undefined}
      title={copied ? "Copied" : `Copy ${label}`}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (insecure context, denied): the value stays selectable.
        }
      }}
    >
      {copied ? <CheckCircle className="h-3.5 w-3.5 text-emerald-400" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
    </button>
  );
}
