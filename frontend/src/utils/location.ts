import { countryName } from "../api/clients";
import type { Device } from "../api/devices";

/** A site's name without the city it starts with: "Durrës – Magazina" in Durrës → "Magazina". */
export function shortSiteName(name: string, city: string): string {
  if (!city || !name.toLowerCase().startsWith(city.toLowerCase())) return name;
  const rest = name.slice(city.length).replace(/^[\s–—\-:,·|/]+/, "");
  return rest || name;
}

export interface SiteView {
  /** ISO country code, e.g. "AL". */
  country: string;
  city: string;
  /** The site's name without its city, e.g. "Magazina". */
  site: string;
  /** One line for text-only places (phone cards): "AL Durrës · Magazina". */
  text: string;
  /** Everything, for a tooltip: "Durrës – Magazina · Durrës, Albania · by rule". */
  title: string;
}

/** How a device's site reads everywhere it is shown, or null when it is at none. */
export function deviceSite(device: Device): SiteView | null {
  if (!device.location_name) return null;
  const country = (device.location_country ?? "").toUpperCase();
  const city = device.location_city ?? "";
  const site = shortSiteName(device.location_name, city);
  const place = [city, country && countryName(country)].filter(Boolean).join(", ");
  const how = device.location_source === "manual" ? "placed by hand" : "by rule";
  return {
    country,
    city,
    site,
    text: [country, [city, site === city ? "" : site].filter(Boolean).join(" · ")].filter(Boolean).join(" "),
    title: [device.location_name, place, how].filter(Boolean).join(" · "),
  };
}
