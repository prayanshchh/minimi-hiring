import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { dayLabel, rangeLabel } from "./time";

/**
 * Turns the Planner's raw time phrase ("last Tuesday", "around Friday", "a couple of weeks ago")
 * into a window on the user's local calendar. Code, not the LLM, does this: it's deterministic,
 * testable with an injected clock, and timezone-correct.
 *
 *  exact  – one local day, 00:00 → 23:59:59.999. Hard filter.
 *  range  – several days. Hard filter.
 *  around – an anchor day. No filter; the Retriever weights by closeness.
 *  none   – no time restriction.
 */
export type TimeWindow =
  | { mode: "none"; phrase: string | null }
  | { mode: "exact" | "range"; start: Date; end: Date; label: string; phrase: string }
  | { mode: "around"; anchor: Date; label: string; phrase: string };

type Span = { kind: "day"; start: DateTime } | { kind: "range"; start: DateTime; end: DateTime };

const AROUND = /^(?:(?:some ?time|somewhere)\s+)?(?:around|about|roughly|approximately|approx\.?|circa|near|~)\s+/;

export function resolveTime(phrase: string | null | undefined, timezone: string, now: Date): TimeWindow {
  const raw = phrase?.trim();
  if (!raw) return { mode: "none", phrase: null };
  const p = raw.toLowerCase().replace(/[?.!,;]+$/g, "");
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");

  const around = AROUND.exec(p);
  const span = resolveSpan(around ? p.slice(around[0].length) : p, today);
  if (!span) return { mode: "none", phrase: raw };

  if (span.kind === "day" && around) {
    return { mode: "around", anchor: span.start.toJSDate(), label: `around ${dayLabel(span.start, timezone, now)}`, phrase: raw };
  }
  if (span.kind === "day") {
    return {
      mode: "exact",
      start: span.start.toJSDate(),
      end: span.start.endOf("day").toJSDate(),
      label: dayLabel(span.start, timezone, now),
      phrase: raw,
    };
  }
  const start = span.start.startOf("day").toJSDate();
  const end = span.end.endOf("day").toJSDate();
  return { mode: "range", start, end, label: rangeLabel(start, end, timezone, now), phrase: raw };
}

// ── Phrases chrono doesn't treat as ranges ─────────────────────────────────

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const day = (start: DateTime): Span => ({ kind: "day", start });
const range = (start: DateTime, end: DateTime): Span => ({ kind: "range", start, end });
/** From `max` days ago to `min` days ago, inclusive. */
const daysAgo = (t: DateTime, min: number, max: number): Span => range(t.minus({ days: max }), t.minus({ days: min }));

/**
 * Saturday of the weekend meant. During a weekend, "the weekend" is this one and "last weekend"
 * the one before; on a weekday both mean the most recent one.
 */
function lastSaturday(t: DateTime, includeCurrent: boolean): DateTime {
  if (t.weekday >= 6) return t.minus({ days: t.weekday - 6 + (includeCurrent ? 0 : 7) });
  return t.minus({ days: t.weekday + 1 });
}

/** Ordered: the first matching rule wins, so longer phrases come before the shorter ones they contain. */
const RULES: Array<[RegExp, (t: DateTime, m: RegExpExecArray) => Span]> = [
  [/\b(?:earlier )?today\b|\bthis (?:morning|afternoon|evening)\b/, (t) => day(t)],
  [/\bthe day before yesterday\b/, (t) => day(t.minus({ days: 2 }))],
  [/\byesterday\b|\blast night\b/, (t) => day(t.minus({ days: 1 }))],
  [/\b(?:in |over |during )?the (?:last|past) (?:few|couple(?: of)?) days\b/, (t) => daysAgo(t, 0, 4)],
  [/\b(?:in |over |during )?the (?:last|past) (?:7|seven) days\b|\b(?:in|over|during) the (?:last|past) week\b|\bthis past week\b|\bthe past week\b/, (t) => daysAgo(t, 0, 6)],
  [/\bthe week before last\b/, (t) => {
    const s = t.startOf("week").minus({ weeks: 2 });
    return range(s, s.endOf("week"));
  }],
  [/\b(?:earlier )?this week\b/, (t) => range(t.startOf("week"), t)],
  [/\b(?:last|previous|past) week\b|\bthe week before\b/, (t) => {
    const s = t.startOf("week").minus({ weeks: 1 });
    return range(s, s.endOf("week"));
  }],
  [/\blast weekend\b/, (t) => {
    const sat = lastSaturday(t, false);
    return range(sat, sat.plus({ days: 1 }));
  }],
  [/\b(?:this past|the|over the) weekend\b/, (t) => {
    const sat = lastSaturday(t, true);
    return range(sat, sat.plus({ days: 1 }));
  }],
  [/\b(?:earlier )?this month\b/, (t) => range(t.startOf("month"), t)],
  [/\b(?:last|previous) month\b/, (t) => {
    const s = t.startOf("month").minus({ months: 1 });
    return range(s, s.endOf("month"));
  }],
  [/\b(?:earlier )?this year\b/, (t) => range(t.startOf("year"), t)],
  [/\b(?:last|previous) year\b/, (t) => {
    const s = t.startOf("year").minus({ years: 1 });
    return range(s, s.endOf("year"));
  }],
  [/\b(?:a )?(?:few|couple(?: of)?) days ago\b/, (t) => daysAgo(t, 2, 6)],
  [/\bthe other day\b/, (t) => daysAgo(t, 1, 7)],
  [/\b(?:a|one) week ago\b/, (t) => daysAgo(t, 5, 9)],
  [/\b(?:a )?couple(?: of)? weeks ago\b/, (t) => daysAgo(t, 10, 18)],
  [/\b(?:a )?few weeks ago\b/, (t) => daysAgo(t, 14, 35)],
  [/\b(\d+|two|three|four|five|six) weeks ago\b/, (t, m) => {
    const n = NUMBER_WORDS[m[1]!] ?? Number(m[1]);
    return daysAgo(t, 7 * n - 4, 7 * n + 4);
  }],
  [/\b(?:a|one) month ago\b/, (t) => daysAgo(t, 21, 40)],
  [/\brecently\b|\blately\b/, (t) => daysAgo(t, 0, 14)],
];

function resolveSpan(p: string, today: DateTime): Span | null {
  for (const [re, make] of RULES) {
    const m = re.exec(p);
    if (m) return make(today, m);
  }
  return resolveWithChrono(p, today) ?? resolveBareOrdinal(p, today);
}

/**
 * chrono parses in the process's zone, so we hand it the user's *wall-clock* date and read back
 * calendar components only (year/month/day/weekday), then rebuild the day in the user's zone.
 */
function resolveWithChrono(p: string, today: DateTime): Span | null {
  const ref = new Date(today.year, today.month - 1, today.day, 12, 0, 0);
  const result = chrono.parse(p, ref)[0];
  if (!result) return null;
  const forward = /\b(?:next|coming|upcoming)\b/.test(p);
  const start = toLocalDay(result.start, today, forward);
  if (result.end) return range(start, toLocalDay(result.end, today, forward));
  const c = result.start;
  if (!c.isCertain("day") && !c.isCertain("weekday") && c.isCertain("month")) {
    return range(start.startOf("month"), start.endOf("month")); // "in October"
  }
  return day(start);
}

function toLocalDay(c: chrono.ParsedComponents, today: DateTime, forward: boolean): DateTime {
  const zone = today.zone;
  // A day name ("Monday", "last Tuesday", "this Friday") = its most recent occurrence before today.
  if (c.isCertain("weekday") && !c.isCertain("day") && !forward) {
    const target = c.get("weekday") === 0 ? 7 : c.get("weekday")!; // chrono: 0=Sun; luxon: 7=Sun
    const back = ((today.weekday - target + 7) % 7) || 7;
    return today.minus({ days: back });
  }
  let dt = DateTime.fromObject({ year: c.get("year")!, month: c.get("month")!, day: c.get("day")! }, { zone });
  // A date without a year ("3 November") = its most recent occurrence, today included.
  if (!c.isCertain("year") && !forward) {
    const limit = c.isCertain("day") ? dt : dt.startOf("month");
    if (limit > today) dt = dt.minus({ years: 1 });
  }
  return dt.startOf("day");
}

/** "on the 3rd" → the most recent 3rd of a month (chrono doesn't parse a bare ordinal). */
function resolveBareOrdinal(p: string, today: DateTime): Span | null {
  const m = /\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/.exec(p);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 31) return null;
  // This month if that day has come, else the most recent earlier month that has a day n.
  for (let back = 0; back < 12; back++) {
    const month = today.startOf("month").minus({ months: back });
    if (n > month.daysInMonth!) continue;
    const dt = month.set({ day: n });
    if (dt <= today) return day(dt);
  }
  return null;
}
