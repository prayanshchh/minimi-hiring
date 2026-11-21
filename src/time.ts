import { DateTime } from "luxon";

/** Small date helpers. Timestamps are stored in UTC; everything shown or interpreted uses the user's zone. */

export function local(d: Date, tz: string): DateTime {
  return DateTime.fromJSDate(d, { zone: tz });
}

/** "Tue 17 Nov", plus the year when it isn't the current one. */
export function dayLabel(d: Date | DateTime, tz: string, now: Date): string {
  const dt = d instanceof Date ? local(d, tz) : d.setZone(tz);
  return dt.toFormat(dt.year === local(now, tz).year ? "ccc d LLL" : "ccc d LLL yyyy");
}

/** "Tue 17 Nov 14:02" (year added when not the current one). */
export function dayTimeLabel(d: Date, tz: string, now: Date): string {
  return `${dayLabel(d, tz, now)} ${local(d, tz).toFormat("HH:mm")}`;
}

/** "9–15 Nov" or "26 Oct – 1 Nov". */
export function rangeLabel(start: Date, end: Date, tz: string, now: Date): string {
  const s = local(start, tz);
  const e = local(end, tz);
  const year = e.year === local(now, tz).year ? "" : ` ${e.year}`;
  if (s.hasSame(e, "day")) return dayLabel(s, tz, now);
  if (s.hasSame(e, "month")) return `${s.day}–${e.day} ${e.toFormat("LLL")}${year}`;
  return `${s.toFormat("d LLL")} – ${e.toFormat("d LLL")}${year}`;
}

/** Whole calendar days between two instants, as seen on the user's wall calendar. */
export function localDayDistance(a: Date, b: Date, tz: string): number {
  const da = local(a, tz).startOf("day");
  const db = local(b, tz).startOf("day");
  return Math.abs(Math.round(da.diff(db, "days").days));
}
