import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { resolveTime, type TimeWindow } from "../src/timeResolver";

const TZ = "Asia/Kolkata";
// Thu 19 Nov 2026, 14:00 IST — the clock is injected, never read from the system.
const NOW = DateTime.fromISO("2026-11-19T14:00:00", { zone: TZ }).toJSDate();

const iso = (d: Date, tz = TZ) => DateTime.fromJSDate(d, { zone: tz }).toISO({ includeOffset: false });
function win(phrase: string | null, tz = TZ, now = NOW) {
  const w = resolveTime(phrase, tz, now);
  return w;
}
function bounds(w: TimeWindow, tz = TZ) {
  if (w.mode !== "exact" && w.mode !== "range") throw new Error(`expected exact/range, got ${w.mode}`);
  return [iso(w.start, tz), iso(w.end, tz)];
}

describe("resolveTime", () => {
  it("returns none for no phrase or an unparseable one", () => {
    expect(win(null).mode).toBe("none");
    expect(win("").mode).toBe("none");
    expect(win("whenever").mode).toBe("none");
  });

  it("day names mean the most recent past occurrence, as one full local day", () => {
    expect(bounds(win("Monday"))).toEqual(["2026-11-16T00:00:00.000", "2026-11-16T23:59:59.999"]);
    expect(bounds(win("last Tuesday"))).toEqual(["2026-11-17T00:00:00.000", "2026-11-17T23:59:59.999"]);
    expect(bounds(win("this Monday"))[0]).toBe("2026-11-16T00:00:00.000");
    // Today is Thursday: "Thursday" means last week's, not today.
    expect(bounds(win("on Thursday"))[0]).toBe("2026-11-12T00:00:00.000");
    expect(bounds(win("last Thursday"))[0]).toBe("2026-11-12T00:00:00.000");
  });

  it("dates without a year mean the most recent past occurrence", () => {
    expect(bounds(win("on 3 November"))[0]).toBe("2026-11-03T00:00:00.000");
    expect(bounds(win("Nov 3rd"))[0]).toBe("2026-11-03T00:00:00.000");
    expect(bounds(win("November 25"))[0]).toBe("2025-11-25T00:00:00.000"); // later this year → last year
    expect(bounds(win("19 November"))[0]).toBe("2026-11-19T00:00:00.000"); // today counts
    expect(bounds(win("on the 3rd"))[0]).toBe("2026-11-03T00:00:00.000");
    expect(bounds(win("on the 25th"))[0]).toBe("2026-10-25T00:00:00.000");
  });

  it("explicit years are kept", () => {
    expect(bounds(win("on 16 Nov 2026"))[0]).toBe("2026-11-16T00:00:00.000");
    expect(win("on 3 November 2025").mode).toBe("exact");
    expect(bounds(win("on 3 November 2025"))[0]).toBe("2025-11-03T00:00:00.000");
  });

  it("relative days", () => {
    expect(bounds(win("yesterday"))[0]).toBe("2026-11-18T00:00:00.000");
    expect(bounds(win("today"))[0]).toBe("2026-11-19T00:00:00.000");
    expect(bounds(win("2 days ago"))[0]).toBe("2026-11-17T00:00:00.000");
  });

  it("around → anchor day, no hard window", () => {
    const w = win("around Tuesday");
    expect(w.mode).toBe("around");
    if (w.mode === "around") {
      expect(iso(w.anchor)).toBe("2026-11-17T00:00:00.000");
      expect(w.label).toBe("around Tue 17 Nov");
    }
    expect(win("sometime around 10 November").mode).toBe("around");
  });

  it("vague phrases → ranges with sensible bounds", () => {
    expect(bounds(win("last week"))).toEqual(["2026-11-09T00:00:00.000", "2026-11-15T23:59:59.999"]);
    expect(bounds(win("earlier this week"))).toEqual(["2026-11-16T00:00:00.000", "2026-11-19T23:59:59.999"]);
    expect(bounds(win("a couple of weeks ago"))).toEqual(["2026-11-01T00:00:00.000", "2026-11-09T23:59:59.999"]); // 10–18 days ago
    expect(bounds(win("recently"))[0]).toBe("2026-11-05T00:00:00.000");
    expect(bounds(win("last month"))).toEqual(["2026-10-01T00:00:00.000", "2026-10-31T23:59:59.999"]);
    expect(bounds(win("in October"))).toEqual(["2026-10-01T00:00:00.000", "2026-10-31T23:59:59.999"]);
    expect(bounds(win("last weekend"))).toEqual(["2026-11-14T00:00:00.000", "2026-11-15T23:59:59.999"]);
  });

  it("labels are human-readable", () => {
    expect(win("last Tuesday")).toMatchObject({ mode: "exact", label: "Tue 17 Nov" });
    expect(win("last week")).toMatchObject({ mode: "range", label: "9–15 Nov" });
    expect(win("a couple of weeks ago")).toMatchObject({ label: "1–9 Nov" });
    expect(win("November 25")).toMatchObject({ label: "Tue 25 Nov 2025" });
  });

  it("uses the user's timezone, not the server's", () => {
    // 01:30 UTC on Thu 19 Nov is still Wed 18 Nov in New York.
    const now = new Date("2026-11-19T01:30:00Z");
    const ny = win("yesterday", "America/New_York", now);
    expect(bounds(ny, "America/New_York")[0]).toBe("2026-11-17T00:00:00.000");
    const tokyo = win("yesterday", "Asia/Tokyo", now);
    expect(bounds(tokyo, "Asia/Tokyo")[0]).toBe("2026-11-18T00:00:00.000");
    // The window is the local day, stored as UTC instants.
    if (ny.mode === "exact") expect(ny.start.toISOString()).toBe("2026-11-17T05:00:00.000Z");
  });

  it("day boundaries sit exactly on local midnight", () => {
    const w = win("Monday");
    if (w.mode !== "exact") throw new Error();
    // Mon 16 Nov IST = 15 Nov 18:30Z → 16 Nov 18:29:59.999Z
    expect(w.start.toISOString()).toBe("2026-11-15T18:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-16T18:29:59.999Z");
    const justBefore = new Date("2026-11-16T18:29:00Z"); // Mon 23:59 IST
    const justAfter = new Date("2026-11-16T18:31:00Z"); // Tue 00:01 IST
    expect(justBefore >= w.start && justBefore <= w.end).toBe(true);
    expect(justAfter >= w.start && justAfter <= w.end).toBe(false);
  });

  it("longer phrases win over the shorter ones they contain (New York, Tue 3 Nov 2026, just after DST ends)", () => {
    const NY = "America/New_York";
    const now = DateTime.fromISO("2026-11-03T10:00:00", { zone: NY }).toJSDate();
    const b = (p: string) => bounds(win(p, NY, now), NY);
    expect(b("the day before yesterday")[0]).toBe("2026-11-01T00:00:00.000");
    expect(b("the week before last")).toEqual(["2026-10-19T00:00:00.000", "2026-10-25T23:59:59.999"]);
    expect(b("in the past week")).toEqual(["2026-10-28T00:00:00.000", "2026-11-03T23:59:59.999"]);
    expect(b("this past week")[1]).toBe("2026-11-03T23:59:59.999");
    expect(b("the last couple of days")).toEqual(["2026-10-30T00:00:00.000", "2026-11-03T23:59:59.999"]);
    expect(b("last year")).toEqual(["2025-01-01T00:00:00.000", "2025-12-31T23:59:59.999"]);
    expect(b("earlier this year")).toEqual(["2026-01-01T00:00:00.000", "2026-11-03T23:59:59.999"]);
    // Sun 1 Nov is a 25-hour local day; the window covers all of it.
    const sun = win("on Sunday", NY, now);
    if (sun.mode === "exact") expect((sun.end.getTime() - sun.start.getTime() + 1) / 3_600_000).toBe(25);
  });

  it("weekends and bare ordinals", () => {
    const sunday = DateTime.fromISO("2026-11-22T12:00:00", { zone: TZ }).toJSDate();
    expect(bounds(win("last weekend", TZ, sunday))[0]).toBe("2026-11-14T00:00:00.000"); // the previous one
    expect(bounds(win("over the weekend", TZ, sunday))[0]).toBe("2026-11-21T00:00:00.000"); // this one
    const dec5 = DateTime.fromISO("2026-12-05T12:00:00", { zone: TZ }).toJSDate();
    expect(bounds(win("on the 31st", TZ, dec5))[0]).toBe("2026-10-31T00:00:00.000"); // November has no 31st
  });

  it("is a pure function of (phrase, timezone, now)", () => {
    const later = DateTime.fromISO("2026-11-24T09:00:00", { zone: TZ }).toJSDate(); // Tue 24 Nov
    expect(bounds(win("Monday", TZ, later))[0]).toBe("2026-11-23T00:00:00.000");
    expect(bounds(win("Tuesday", TZ, later))[0]).toBe("2026-11-17T00:00:00.000");
    expect(win("Monday")).toEqual(win("Monday"));
  });
});
