/**
 * Picks the passage of a cited page worth saving as the observation: the lines that best match
 * the claims citing it (numbers weigh most: prices, limits, versions), grown into a ~2k window,
 * with the nearest heading and, inside a table, the table's header row. So a later turn can see
 * "Forecasting | Professional and above" with its columns, not a context-free number.
 */

const STOP = new Set("the a an and or of to in on for with is are was were be by at as it its this that from per you your we our i".split(" "));

/** Sentences of the answer that cite source n, e.g. "...is $20/seat [2]." */
export function claimsCiting(answer: string, n: number): string[] {
  const marker = new RegExp(`\\[${n}\\]`);
  return answer.split(/(?<=[.!?])\s+|\n+/).filter((s) => marker.test(s));
}

export function selectExcerpt(text: string, highlights: string[], claims: string[], maxChars: number): string {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const fallback = () => (highlights.length ? highlights.join("\n…\n") : lines.join("\n")).slice(0, maxChars);
  const terms = claimTerms(claims);
  if (!lines.length || !terms.size) return fallback();

  const scores = lines.map((l) => lineScore(l, terms));
  let best = 0;
  scores.forEach((s, i) => { if (s > scores[best]!) best = i; });
  if (scores[best] === 0) return fallback();

  // Context that makes the passage readable on its own.
  const context: string[] = [];
  const header = tableHeader(lines, best);
  const heading = nearestHeading(lines, header ? header.index : best);
  if (heading) context.push(heading.line);
  if (header) context.push(...header.rows);
  const contextLen = context.join("\n").length;

  // Grow around the best line, favouring what follows (values usually come after their label).
  let lo = best, hi = best, len = lines[best]!.length;
  const budget = Math.max(200, maxChars - contextLen - 4);
  while (true) {
    const canDown = hi + 1 < lines.length, canUp = lo - 1 >= 0;
    if (!canDown && !canUp) break;
    const next = canDown && (!canUp || hi - best <= 2 * (best - lo)) ? hi + 1 : lo - 1;
    if (len + lines[next]!.length + 1 > budget) break;
    if (next > hi) hi = next; else lo = next;
    len += lines[next]!.length + 1;
  }
  const body = lines.slice(lo, hi + 1);
  const ctx = context.filter((c) => !body.includes(c));
  return [...ctx, ...(ctx.length ? ["…"] : []), ...body].join("\n").slice(0, maxChars);
}

function claimTerms(claims: string[]): Map<string, number> {
  const terms = new Map<string, number>();
  for (const claim of claims) {
    const clean = claim.replace(/\[\d+\]|<\/?q[^>]*>/g, " ");
    for (const num of clean.match(/[$€£₹]?\d[\d,.]*/g) ?? []) terms.set(num.replace(/[$€£₹,]/g, ""), 3);
    for (const w of clean.toLowerCase().match(/[a-z][a-z0-9+-]{2,}/g) ?? []) if (!STOP.has(w) && !terms.has(w)) terms.set(w, 1);
  }
  return terms;
}

function lineScore(line: string, terms: Map<string, number>): number {
  const lower = line.toLowerCase().replace(/,/g, "");
  let score = 0;
  for (const [t, w] of terms) if (lower.includes(t)) score += w;
  return score;
}

function nearestHeading(lines: string[], from: number): { index: number; line: string } | null {
  for (let i = from; i >= Math.max(0, from - 40); i--) {
    const l = lines[i]!;
    if (/^#{1,6}\s/.test(l) || (l.length < 60 && !/[.|]$/.test(l) && /^[A-Z]/.test(l) && i !== from)) return { index: i, line: l };
  }
  return null;
}

function tableHeader(lines: string[], at: number): { index: number; rows: string[] } | null {
  if (!lines[at]!.includes("|")) return null;
  let i = at;
  while (i > 0 && lines[i - 1]!.includes("|")) i--;
  if (i === at) return null;
  const rows = [lines[i]!];
  if (lines[i + 1] && /^[\s|:-]+$/.test(lines[i + 1]!)) rows.push(lines[i + 1]!);
  return { index: i, rows };
}
