import type { Device } from "../api/devices";
import { deviceSite } from "../utils/location";
import CountryTag from "./CountryTag";

/** A device's site as one line: [AL] Durrës · Magazina. Null at no site. */
export default function SiteLine({ device, className = "" }: { device: Device; className?: string }) {
  const site = deviceSite(device);
  if (!site) return null;
  return (
    <span className={`th-site-line ${className}`} title={site.title}>
      <CountryTag code={site.country} />
      <span className="truncate">
        {site.city}
        {site.site !== site.city && (
          <>
            <span aria-hidden="true" className="th-site-sep">
              {" "}
              ·{" "}
            </span>
            {site.site}
          </>
        )}
      </span>
    </span>
  );
}
