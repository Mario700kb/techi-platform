import { DISPLAY_LOCALE } from "./time";

const COUNT_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE);

// Counts shown to operators get the same grouping everywhere ("1,234").
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}
