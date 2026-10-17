import { useLayoutEffect, useRef } from "react";
import type { ConsoleCommand } from "./titleMarker";
import { clock, duration, PanelSection } from "./parts";

/** "This session": what ran, newest at the bottom, following new commands. */
export default function SessionCommands({
  commands,
  className,
  listClassName = "",
}: {
  commands: ConsoleCommand[];
  className?: string;
  listClassName?: string;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [commands.length]);

  return (
    <PanelSection title="This session" className={className} bodyClassName="flex min-h-0 flex-1 flex-col">
      {commands.length === 0 ? (
        <p className="ps-empty">Commands you run show up here.</p>
      ) : (
        <ol
          ref={listRef}
          aria-label="Commands this session"
          className={`ps-commands min-h-0 flex-1 overflow-y-auto ${listClassName}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {commands.map((c) => {
            const took = duration(c.durationMs);
            const tip = [c.label === c.command ? c.command : `${c.label}\n${c.command}`, took && `took ${took}`]
              .filter(Boolean)
              .join("\n");
            return (
              <li key={c.key} className="ps-command" data-failed={c.failed ? "true" : undefined} title={tip}>
                <time className="ps-command-time" dateTime={new Date(c.at).toISOString()}>
                  {clock(c.at)}
                </time>
                <span className="ps-command-text">{c.label.replace(/\s*\n\s*/g, " ⏎ ")}</span>
                <span className="ps-command-meta">
                  {took && <span className="ps-command-took">{took}</span>}
                  {c.failed && (
                    <span className="ps-command-failed">
                      <span className="ps-fail-dot" aria-hidden="true" />
                      failed
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </PanelSection>
  );
}
