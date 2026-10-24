import { useEffect, useRef, useState } from "react";

import { useFlashOnChange } from "../../hooks/useLiveChange";
import { motionAllowed } from "../../utils/motion";

const TWEEN_MS = 650;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

interface AnimatedNumberProps {
  value: number;
  /** Formats every frame, e.g. formatCount; rounds by default. */
  format?: (value: number) => string;
  className?: string;
}

/**
 * A figure that counts to its new value instead of jumping, and is
 * highlighted for a moment when it changes. The first value is shown as is.
 */
export default function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const changed = useFlashOnChange(value);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    if (!motionAllowed()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const next = t === 1 ? value : from + (value - from) * easeOutCubic(t);
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  // Whole numbers count through whole numbers.
  const current = Number.isInteger(value) ? Math.round(shown) : shown;
  const text = format ? format(current) : String(current);
  return (
    <span className={`th-num ${className ?? ""}`} data-changed={changed || undefined}>
      {text}
    </span>
  );
}
