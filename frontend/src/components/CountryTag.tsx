import { countryName } from "../api/clients";

/** A country as its ISO code in a small tag — the same on every operating
 *  system, where flag emoji are not (Windows draws them as two letters). */
export default function CountryTag({ code }: { code: string }) {
  if (!code) return null;
  return (
    <abbr className="th-country" title={countryName(code)}>
      {code.toUpperCase()}
    </abbr>
  );
}
