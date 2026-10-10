import { useEffect, useState } from "react";
import { APP_TIME_ZONE } from "../utils/time";

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** Live Tirana clock for the top bar, so operators always see platform time. */
export default function TopbarClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Tick on the second boundary so the display never lags a full second.
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  return (
    <time
      dateTime={now.toISOString()}
      title="Platform time — Tirana (Europe/Tirane)"
      className="th-clock"
    >
      <span className="font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>{timeFormat.format(now)}</span>
      <span style={{ color: "var(--th-text-muted)" }}>{dateFormat.format(now)}</span>
      <span style={{ color: "var(--th-text-faint)" }}>Tirana</span>
    </time>
  );
}
