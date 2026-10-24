import { useEffect, useRef, useState } from "react";

import { FLASH_MS, motionAllowed } from "../utils/motion";

/**
 * True for a moment after `value` changes — not on the first render — so a
 * value that a live event or a refresh changed is highlighted where it is
 * shown (`data-changed`, index.css). Changes that arrive while one is shown
 * restart the highlight.
 */
export function useFlashOnChange(value: unknown): boolean {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    if (!motionAllowed()) return;
    setChanged(true);
    const timer = window.setTimeout(() => setChanged(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return changed;
}

/** More rows than this appearing at once is a new page or filter, not news. */
const MAX_NEW_AT_ONCE = 3;

/**
 * The keys that appeared since the previous render — none on the first one,
 * so a page that loads does not light up every row; a row that arrives live
 * does. Paging or filtering, which swaps many rows at once, lights up none.
 */
export function useNewKeys<K>(keys: readonly K[]): ReadonlySet<K> {
  const seen = useRef<Set<K> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [fresh, setFresh] = useState<ReadonlySet<K>>(() => new Set());
  const signature = keys.join("|");
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(keys);
    if (before === null || !motionAllowed()) return;
    const added = keys.filter((key) => !before.has(key));
    const kept = keys.length - added.length;
    if (added.length === 0 || added.length > MAX_NEW_AT_ONCE || (before.size > 0 && kept === 0)) return;
    setFresh(new Set(added));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFresh(new Set()), FLASH_MS);
    // The signature stands for the keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return fresh;
}
