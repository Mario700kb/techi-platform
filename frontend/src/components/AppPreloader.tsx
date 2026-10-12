import { useState } from "react";

const ENTER_DELAY_MS = 150;
const SLIDE_MS = 1400;

/**
 * Full-screen loading state, identical to the boot screen in index.html, where
 * its styles live so that screen paints before any bundle loads. Both screens
 * anchor their animations to page load, so React replacing the boot markup
 * neither replays the fade-in nor restarts the bar.
 *
 * `inline` is the in-page variant (bar only), for content that is still
 * resolving inside an already rendered shell.
 */
export default function AppPreloader({
  inline = false,
  label = "Loading TECHI Connect",
}: {
  inline?: boolean;
  label?: string;
}) {
  const [phase] = useState(() => {
    const now = performance.now();
    return {
      enter: inline ? `${ENTER_DELAY_MS}ms` : `${Math.round(ENTER_DELAY_MS - now)}ms`,
      slide: `${-Math.round(now % SLIDE_MS)}ms`,
    };
  });

  return (
    <div className={inline ? "th-preloader th-preloader--inline" : "th-preloader"} role="status" aria-label={label}>
      <div className="th-preloader__stack" style={{ animationDelay: phase.enter }}>
        {!inline && (
          <img className="th-preloader__mark" src="/brand/connect-symbol.svg" alt="" width={44} height={44} />
        )}
        <div className="th-preloader__track">
          <div className="th-preloader__bar" style={{ animationDelay: phase.slide }} />
        </div>
        {!inline && <div className="th-preloader__label">TECHI Connect</div>}
      </div>
    </div>
  );
}
