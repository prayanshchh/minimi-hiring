import { config } from "./config";
import type { DB } from "./db";
import { toVector, type Embedder } from "./models";
import type { ResolvedQuestion } from "./planner";
import { dayLabel, local, localDayDistance, rangeLabel } from "./time";
import type { TimeWindow } from "./timeResolver";

/**
 * Retriever: for each question, which past exchanges match it, and the memories behind them.
 * The Answerer reads only those memories; it can fetch the chats themselves with a tool.
 * Pure code + the embedding model. No chat model, so it is fast, testable and deterministic:
 * every SQL ORDER BY and every JS sort ends with an id tie-break.
 */

export type DateSide = "user" | "assistant" | "either";
export type MatchedSide = "user" | "assistant" | "both";
export type Match = { exchangeId: string; matchedSide: MatchedSide; at: Date };
export type RetrievedSession = {
  sessionId: string;
  title: string;
  /** Local day of the first match, e.g. "Mon 16 Nov". */
  date: string;
  score: number;
  matches: Match[];
};
/** A memory handed to the Answerer: the user's own words, with where it came from. */
export type RetrievedMemory = {
  ref: string; // "m_1a2b3c4d": how the Answerer names it to its tools
  id: string;
  exchangeId: string;
  sessionId: string;
  kind: "preference" | "decision" | "request";
  text: string;
  at: Date;
  /** The exchange itself matched the question (otherwise it is from the same chat). */
  matched: boolean;
  /** From the nearest chat on another day: offered, not the date asked about. */
  otherDay: boolean;
  /** The reply to that exchange cited web pages, saved word for word. */
  hasWeb: boolean;
};

export type RetrievalResult = {
  queryId: string;
  status: "found" | "none_on_date" | "no_match";
  /** Memories for this question, oldest first. */
  memories: RetrievedMemory[];
  /** The Planner asked for every memory (a broad question): no search was run. */
  all?: boolean;
  /** Human-readable scope, e.g. "Tue 17 Nov only" or "all history". */
  searched: string;
  sessions: RetrievedSession[];
  nearestElsewhere?: { sessionId: string; title: string; date: string };
  /** Exact-date questions: the Context Packer must not pull in neighbours outside this window. */
  clip?: { start: Date; end: Date; side: DateSide };
};

type Deps = { db: DB; embedder: Embedder };
type Input = { userId: string; currentSessionId: string | null; timezone: string; now: Date; questions: ResolvedQuestion[] };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function retrieve(deps: Deps, input: Input): Promise<RetrievalResult[]> {
  const questions = input.questions.filter((q) => q.needsMemory);
  // One embedding call for every query text of this turn (the backup query is shared).
  const texts = [...new Set(questions.filter((q) => !q.dateOnly).flatMap((q) => [q.query, q.backupQuery ?? ""]).filter(Boolean))];
  const vectors = new Map<string, number[]>();
  if (texts.length) (await deps.embedder.embed(texts, "query")).forEach((v, i) => vectors.set(texts[i]!, v));

  const results: RetrievalResult[] = [];
  for (const q of questions) {
    if (q.allMemories && q.window.mode === "none") {
      results.push(await everyMemory(deps.db, input, q));
      continue;
    }
    const r = q.dateOnly ? await dateOnlySearch(deps.db, input, q) : await topicSearch(deps.db, input, q, vectors, deps.embedder.minSimilarity);
    results.push({ ...r, memories: await memoriesFor(deps.db, input.userId, r) });
  }
  return results;
}

/**
 * A broad question ("what do you know about me?", "pick a film for me"): no search, no filter.
 * Every memory the user has, from every past chat, oldest first. Only the current chat is left
 * out, because the Answerer already has it in full.
 */
async function everyMemory(db: DB, input: Input, q: ResolvedQuestion): Promise<RetrievalResult> {
  const { rows } = await db.query<{ id: string; exchange_id: string; session_id: string; kind: RetrievedMemory["kind"]; text: string; at: Date; has_web: boolean }>(
    `SELECT m.id, m.exchange_id, m.session_id, m.kind, m.text, e.user_sent_at AS at,
            EXISTS (SELECT 1 FROM observations o WHERE o.exchange_id = m.exchange_id) AS has_web
       FROM memories m JOIN exchanges e ON e.id = m.exchange_id
      WHERE m.user_id = $1 AND m.session_id <> $2
      ORDER BY e.user_sent_at, m.id`,
    [input.userId, input.currentSessionId ?? NIL_UUID],
  );
  const memories = rows.map((m): RetrievedMemory => ({
    ref: memRef(m.id), id: m.id, exchangeId: m.exchange_id, sessionId: m.session_id, kind: m.kind, text: m.text, at: m.at,
    matched: true, otherDay: false, hasWeb: m.has_web,
  }));
  return { queryId: q.queryId, status: memories.length ? "found" : "no_match", searched: "every memory", sessions: [], memories, all: true };
}

/** "m_1a2b3c4d": short and stable, never a full UUID in a prompt. */
export const memRef = (memoryId: string) => `m_${memoryId.slice(0, 8)}`;

/**
 * The memories behind a result: those of the matched exchanges and the rest of those chats (a
 * decision often sits in the next message). For a date question only the matched ones, so other
 * days can't slip in. With nothing on the date, the nearest chat's memories, marked as another day.
 */
async function memoriesFor(db: DB, userId: string, r: Omit<RetrievalResult, "memories">): Promise<RetrievedMemory[]> {
  const matched = new Set(r.sessions.flatMap((s) => s.matches.map((m) => m.exchangeId)));
  const sessionIds = r.sessions.map((s) => s.sessionId);
  const near = r.nearestElsewhere?.sessionId;
  if (near) sessionIds.push(near);
  if (!sessionIds.length) return [];
  const { rows } = await db.query<{ id: string; exchange_id: string; session_id: string; kind: RetrievedMemory["kind"]; text: string; at: Date; has_web: boolean }>(
    `SELECT m.id, m.exchange_id, m.session_id, m.kind, m.text, e.user_sent_at AS at,
            EXISTS (SELECT 1 FROM observations o WHERE o.exchange_id = m.exchange_id) AS has_web
       FROM memories m JOIN exchanges e ON e.id = m.exchange_id
      WHERE m.user_id = $1 AND m.session_id = ANY($2::uuid[])
      ORDER BY e.user_sent_at, m.id`,
    [userId, sessionIds],
  );
  const all = rows
    .map((m): RetrievedMemory => ({
      ref: memRef(m.id), id: m.id, exchangeId: m.exchange_id, sessionId: m.session_id, kind: m.kind, text: m.text, at: m.at,
      matched: matched.has(m.exchange_id), otherDay: m.session_id === near, hasWeb: m.has_web,
    }))
    .filter((m) => m.matched || m.otherDay || !r.clip);
  return all; // already oldest first; no cap: memories are small, and the Answerer reads them all
}

// ── Topic questions ────────────────────────────────────────────────────────

type Candidate = {
  exchangeId: string;
  sessionId: string;
  userSentAt: Date;
  assistantSentAt: Date;
  rrf: number;
  bestSim: number;
  coverage: number;
  userHit: boolean;
  assistantHit: boolean;
  score: number;
};

type Found = Omit<RetrievalResult, "memories">;

async function topicSearch(db: DB, input: Input, q: ResolvedQuestion, vectors: Map<string, number[]>, minSim: number): Promise<Found> {
  const searched = scopeLabel(q, input.timezone, input.now);
  const clip = q.window.mode === "exact" ? { start: q.window.start, end: q.window.end, side: q.dateSide } : undefined;
  const ranked = await rankCandidates(db, input, q, q.window, vectors, minSim);

  if (ranked.length) {
    return { queryId: q.queryId, status: "found", searched, sessions: await toSessions(db, input, pickSessions(ranked)), clip };
  }
  if (q.window.mode === "exact" || q.window.mode === "range") {
    // Nothing on that date. Search all history, weighted towards the requested date, and offer
    // the best hit, clearly labelled as not the answer.
    const anchor = windowCenter(q.window, input.timezone);
    const around: TimeWindow = { mode: "around", anchor, label: "", phrase: "" };
    const elsewhere = await rankCandidates(db, input, q, around, vectors, minSim);
    const best = elsewhere.length ? (await toSessions(db, input, pickSessions(elsewhere).slice(0, 1)))[0] : undefined;
    return {
      queryId: q.queryId,
      status: "none_on_date",
      searched,
      sessions: [],
      nearestElsewhere: best && { sessionId: best.sessionId, title: best.title, date: best.date },
      clip,
    };
  }
  return { queryId: q.queryId, status: "no_match", searched, sessions: [] };
}

/**
 * Hybrid search inside the date window:
 *   for the planned query and the backup (raw message) query,
 *   FTS + vector, over exchanges and memories (a memory hit counts for its exchange) → up to 8 lists,
 *   fused with Reciprocal Rank Fusion, then gated by an absolute relevance floor,
 *   then adjusted for "around" dates, speaker and recency.
 */
async function rankCandidates(db: DB, input: Input, q: ResolvedQuestion, window: TimeWindow, vectors: Map<string, number[]>, minSim: number): Promise<Candidate[]> {
  const cands = new Map<string, Candidate>();
  const scope = { userId: input.userId, currentSessionId: input.currentSessionId ?? NIL_UUID, window, side: q.dateSide };

  const fuse = (rows: ListRow[], opts: { primary: boolean }) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const c = cands.get(r.exchange_id) ?? {
        exchangeId: r.exchange_id, sessionId: r.session_id, userSentAt: r.user_sent_at, assistantSentAt: r.assistant_sent_at,
        rrf: 0, bestSim: 0, coverage: 0, userHit: false, assistantHit: false, score: 0,
      };
      // Several memories of one exchange: the exchange's rank is its best row's, but evidence comes from all rows.
      if (!seen.has(r.exchange_id)) {
        seen.add(r.exchange_id);
        c.rrf += 1 / (config.RRF_K + seen.size);
      }
      if (r.sim != null) c.bestSim = Math.max(c.bestSim, r.sim);
      // Coverage and speaker come from the planned query only: the raw message OR-s every word
      // and would mark nearly everything as a hit on both sides.
      if (opts.primary) {
        if (r.coverage != null) c.coverage = Math.max(c.coverage, r.coverage);
        if (r.user_hit) c.userHit = true;
        if (r.assistant_hit) c.assistantHit = true;
      }
      cands.set(r.exchange_id, c);
    }
  };

  const keywordText = q.keywords.length ? q.keywords.join(" ") : q.query;
  const queries: Array<{ text: string; terms: string; primary: boolean }> = [{ text: q.query, terms: keywordText, primary: true }];
  if (q.backupQuery) queries.push({ text: q.backupQuery, terms: q.backupQuery, primary: false });

  for (const { text, terms, primary } of queries) {
    const vec = vectors.get(text);
    fuse(await ftsList(db, scope, "exchanges", terms), { primary });
    fuse(await ftsList(db, scope, "memories", terms), { primary });
    if (vec) {
      fuse(await vectorList(db, scope, "exchanges", vec), { primary });
      fuse(await vectorList(db, scope, "memories", vec), { primary });
    }
  }

  const passed = [...cands.values()].filter((c) => c.bestSim >= minSim || c.coverage >= config.FTS_MIN_COVERAGE);
  for (const c of passed) {
    let score = c.rrf;
    if (window.mode === "around") score *= aroundWeight(distanceDays(c, window.anchor, q.dateSide, input.timezone));
    if (q.dateSide === "user" && c.userHit) score *= config.SPEAKER_BOOST;
    if (q.dateSide === "assistant" && c.assistantHit) score *= config.SPEAKER_BOOST;
    if (q.wantsCurrent) {
      const ageDays = (input.now.getTime() - c.userSentAt.getTime()) / 86_400_000;
      score *= 1 + config.RECENCY_BOOST_MAX * 0.5 ** (Math.max(0, ageDays) / config.RECENCY_HALF_LIFE_DAYS);
    }
    c.score = score;
  }
  return passed.sort((a, b) => b.score - a.score || a.exchangeId.localeCompare(b.exchangeId));
}

/**
 * Exchange hits → sessions. Each session appears once, with all its matched exchanges; its score is
 * its best exchange. Every session above the relevance bar is kept: only memories reach the
 * Answerer, so there is no reason to cut, and a later revision can never be crowded out.
 */
type SessionHit = { sessionId: string; score: number; first: Date; last: Date; cands: Candidate[] };

function pickSessions(ranked: Candidate[]): SessionHit[] {
  const bySession = new Map<string, SessionHit>();
  for (const c of ranked) {
    const s = bySession.get(c.sessionId) ?? { sessionId: c.sessionId, score: 0, first: c.userSentAt, last: c.userSentAt, cands: [] };
    s.score = Math.max(s.score, c.score);
    if (c.userSentAt < s.first) s.first = c.userSentAt;
    if (c.userSentAt > s.last) s.last = c.userSentAt;
    s.cands.push(c);
    bySession.set(c.sessionId, s);
  }
  return [...bySession.values()].sort((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId));
}

async function toSessions(db: DB, input: Input, hits: SessionHit[]): Promise<RetrievedSession[]> {
  const titles = await sessionTitles(db, hits.map((h) => h.sessionId));
  return hits.map((h) => ({
    sessionId: h.sessionId,
    title: titles.get(h.sessionId) ?? "Untitled",
    date: dayLabel(h.first, input.timezone, input.now),
    score: round(h.score),
    matches: h.cands
      .map((c) => ({ exchangeId: c.exchangeId, matchedSide: side(c), at: c.userSentAt }))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.exchangeId.localeCompare(b.exchangeId)),
  }));
}

const side = (c: Candidate): MatchedSide => (c.userHit && !c.assistantHit ? "user" : c.assistantHit && !c.userHit ? "assistant" : "both");

// ── Date-only questions ────────────────────────────────────────────────────

/**
 * "What did I ask on 3 November?" has no topic, so there is nothing to rank: return every session
 * with exchanges in the window (on the side the question names), in time order, no cut-off.
 */
async function dateOnlySearch(db: DB, input: Input, q: ResolvedQuestion): Promise<Found> {
  const w = q.window;
  if (w.mode === "none") return latestSessions(db, input, q);

  const window =
    w.mode === "around"
      ? {
          start: local(w.anchor, input.timezone).minus({ days: config.AROUND_DATE_ONLY_DAYS }).startOf("day").toJSDate(),
          end: local(w.anchor, input.timezone).plus({ days: config.AROUND_DATE_ONLY_DAYS }).endOf("day").toJSDate(),
        }
      : { start: w.start, end: w.end };
  const searched = scopeLabel(q, input.timezone, input.now);
  const clip = w.mode === "exact" ? { start: w.start, end: w.end, side: q.dateSide } : undefined;

  const params: unknown[] = [input.userId, input.currentSessionId ?? NIL_UUID, window.start, window.end];
  const inUser = `(e.user_sent_at BETWEEN $3 AND $4)`;
  const inAsst = `(e.assistant_sent_at BETWEEN $3 AND $4)`;
  const filter = q.dateSide === "user" ? inUser : q.dateSide === "assistant" ? inAsst : `(${inUser} OR ${inAsst})`;
  const { rows } = await db.query<{ id: string; session_id: string; user_sent_at: Date; u: boolean; a: boolean }>(
    `SELECT e.id, e.session_id, e.user_sent_at, ${inUser} AS u, ${inAsst} AS a
       FROM exchanges e
      WHERE e.user_id = $1 AND e.status = 'complete' AND e.session_id <> $2 AND ${filter}
      ORDER BY e.user_sent_at, e.id`,
    params,
  );

  if (!rows.length) {
    return { queryId: q.queryId, status: "none_on_date", searched, sessions: [], nearestElsewhere: await nearestInTime(db, input, window), clip };
  }

  const order: string[] = [];
  const matches = new Map<string, Match[]>();
  for (const r of rows) {
    if (!matches.has(r.session_id)) order.push(r.session_id);
    const list = matches.get(r.session_id) ?? [];
    const matchedSide: MatchedSide = q.dateSide === "user" ? "user" : q.dateSide === "assistant" ? "assistant" : r.u && r.a ? "both" : r.u ? "user" : "assistant";
    list.push({ exchangeId: r.id, matchedSide, at: r.user_sent_at });
    matches.set(r.session_id, list);
  }
  const ids = order; // every chat in the window, in time order
  const titles = await sessionTitles(db, ids);
  return {
    queryId: q.queryId,
    status: "found",
    searched,
    clip,
    sessions: ids.map((id, i) => ({
      sessionId: id,
      title: titles.get(id) ?? "Untitled",
      date: dayLabel(matches.get(id)![0]!.at, input.timezone, input.now),
      score: round(1 / (i + 1)), // time order is the ranking
      matches: matches.get(id)!,
    })),
  };
}

/** No date and no topic ("what did we talk about last time?"): the most recent sessions, their final exchanges. */
async function latestSessions(db: DB, input: Input, q: ResolvedQuestion): Promise<Found> {
  const { rows } = await db.query<{ session_id: string }>(
    `SELECT session_id FROM exchanges
      WHERE user_id = $1 AND status = 'complete' AND session_id <> $2
      GROUP BY session_id ORDER BY max(user_sent_at) DESC, session_id LIMIT $3`,
    [input.userId, input.currentSessionId ?? NIL_UUID, config.LATEST_SESSIONS],
  );
  const searched = scopeLabel(q, input.timezone, input.now);
  if (!rows.length) return { queryId: q.queryId, status: "no_match", searched, sessions: [] };
  const titles = await sessionTitles(db, rows.map((r) => r.session_id));
  const sessions: RetrievedSession[] = [];
  for (const [i, { session_id }] of rows.entries()) {
    const ex = await db.query<{ id: string; user_sent_at: Date }>(
      `SELECT id, user_sent_at FROM exchanges WHERE session_id = $1 AND status = 'complete' ORDER BY seq DESC LIMIT $2`,
      [session_id, config.LATEST_EXCHANGES_PER_SESSION],
    );
    const matches = ex.rows.reverse().map((r) => ({ exchangeId: r.id, matchedSide: "both" as const, at: r.user_sent_at }));
    sessions.push({ sessionId: session_id, title: titles.get(session_id) ?? "Untitled", date: dayLabel(matches[0]!.at, input.timezone, input.now), score: round(1 / (i + 1)), matches });
  }
  return { queryId: q.queryId, status: "found", searched, sessions };
}

async function nearestInTime(db: DB, input: Input, window: { start: Date; end: Date }) {
  const mid = new Date((window.start.getTime() + window.end.getTime()) / 2);
  const { rows } = await db.query<{ session_id: string; user_sent_at: Date; title: string }>(
    `SELECT e.session_id, e.user_sent_at, s.title FROM exchanges e JOIN sessions s ON s.id = e.session_id
      WHERE e.user_id = $1 AND e.status = 'complete' AND e.session_id <> $2
      ORDER BY abs(extract(epoch FROM e.user_sent_at - $3::timestamptz)), e.id LIMIT 1`,
    [input.userId, input.currentSessionId ?? NIL_UUID, mid],
  );
  const r = rows[0];
  return r ? { sessionId: r.session_id, title: r.title, date: dayLabel(r.user_sent_at, input.timezone, input.now) } : undefined;
}

// ── SQL candidate lists ────────────────────────────────────────────────────

type Scope = { userId: string; currentSessionId: string; window: TimeWindow; side: DateSide };
type ListRow = {
  exchange_id: string; session_id: string; user_sent_at: Date; assistant_sent_at: Date;
  sim?: number; coverage?: number; user_hit?: boolean; assistant_hit?: boolean;
};

/** WHERE clause shared by every list: this user, complete exchanges, not the current chat, inside the window. */
function scopeSql(scope: Scope, params: unknown[]): string {
  params.push(scope.userId, scope.currentSessionId);
  let sql = `e.user_id = $${params.length - 1} AND e.status = 'complete' AND e.session_id <> $${params.length}`;
  const w = scope.window;
  if (w.mode === "exact" || w.mode === "range") {
    // Hard filter, applied before any ranking, on the side the question names.
    params.push(w.start, w.end);
    const [s, e] = [`$${params.length - 1}`, `$${params.length}`];
    const u = `e.user_sent_at BETWEEN ${s} AND ${e}`;
    const a = `e.assistant_sent_at BETWEEN ${s} AND ${e}`;
    sql += scope.side === "user" ? ` AND ${u}` : scope.side === "assistant" ? ` AND ${a}` : ` AND (${u} OR ${a})`;
  }
  return sql;
}

/**
 * Keyword list. Terms are the question's keywords, stemmed by Postgres ('english'), OR-ed together
 * and ranked by ts_rank. `coverage` = share of the terms the row contains (used by the relevance floor).
 */
async function ftsList(db: DB, scope: Scope, table: "exchanges" | "memories", terms: string): Promise<ListRow[]> {
  const params: unknown[] = [terms];
  const where = scopeSql(scope, params);
  const isMem = table === "memories";
  const fts = isMem ? "m.fts" : "e.fts";
  const { rows } = await db.query<ListRow>(
    `WITH terms AS (SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1::text))) AS t),
          q AS (SELECT array_to_string(array_agg(quote_literal(t)), ' | ')::tsquery AS q, count(*) AS n FROM terms)
     SELECT e.id AS exchange_id, e.session_id, e.user_sent_at, e.assistant_sent_at,
            (SELECT count(*) FROM terms WHERE ${fts} @@ quote_literal(terms.t)::tsquery)::float / q.n AS coverage,
            ${isMem ? "m.speaker = 'user'" : "to_tsvector('english', e.user_text) @@ q.q"} AS user_hit,
            ${isMem ? "m.speaker = 'assistant'" : "to_tsvector('english', coalesce(e.assistant_text, '')) @@ q.q"} AS assistant_hit
       FROM q, ${isMem ? "memories m JOIN exchanges e ON e.id = m.exchange_id" : "exchanges e"}
      WHERE q.n > 0 AND ${fts} @@ q.q AND ${where}
      ORDER BY ts_rank(${fts}, q.q) DESC, e.id${isMem ? ", m.id" : ""}
      LIMIT ${config.CANDIDATES_PER_LIST}`,
    params,
  );
  return rows;
}

/** Vector list: cosine similarity on the exchange embedding (both sides) or the memory embedding. */
async function vectorList(db: DB, scope: Scope, table: "exchanges" | "memories", vec: number[]): Promise<ListRow[]> {
  const params: unknown[] = [toVector(vec)];
  const where = scopeSql(scope, params);
  const isMem = table === "memories";
  const col = isMem ? "m.embedding" : "e.embedding";
  const { rows } = await db.query<ListRow>(
    `SELECT e.id AS exchange_id, e.session_id, e.user_sent_at, e.assistant_sent_at, 1 - (${col} <=> $1::vector) AS sim
            ${isMem ? ", m.speaker = 'user' AS user_hit, m.speaker = 'assistant' AS assistant_hit" : ""}
       FROM ${isMem ? "memories m JOIN exchanges e ON e.id = m.exchange_id" : "exchanges e"}
      WHERE ${col} IS NOT NULL AND ${where}
      ORDER BY ${col} <=> $1::vector, e.id${isMem ? ", m.id" : ""}
      LIMIT ${config.CANDIDATES_PER_LIST}`,
    params,
  );
  return rows;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function sessionTitles(db: DB, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ id: string; title: string }>(`SELECT id, title FROM sessions WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r.title]));
}

function distanceDays(c: Candidate, anchor: Date, dateSide: DateSide, tz: string): number {
  const du = localDayDistance(c.userSentAt, anchor, tz);
  const da = localDayDistance(c.assistantSentAt, anchor, tz);
  return dateSide === "user" ? du : dateSide === "assistant" ? da : Math.min(du, da);
}

export function aroundWeight(days: number): number {
  const table = config.AROUND_DAY_WEIGHTS;
  if (days < table.length) return table[days]!;
  return Math.max(config.AROUND_MIN_WEIGHT, table[table.length - 1]! - config.AROUND_DECAY_PER_DAY * (days - table.length + 1));
}

function windowCenter(w: { start: Date; end: Date }, tz: string): Date {
  return local(new Date((w.start.getTime() + w.end.getTime()) / 2), tz).startOf("day").toJSDate();
}

const sideNote = (s: DateSide) => (s === "user" ? " (your messages)" : s === "assistant" ? " (my replies)" : "");

/** What a question will search, in words ("Tue 17 Nov only (your messages)"). Shown in the UI and the prompt. */
export function scopeLabel(q: ResolvedQuestion, tz: string, now: Date): string {
  const w = q.window;
  if (q.allMemories && w.mode === "none") return "every memory";
  if (q.dateOnly && w.mode === "none") return "your most recent chats";
  if (q.dateOnly && w.mode === "around") {
    const a = local(w.anchor, tz);
    const start = a.minus({ days: config.AROUND_DATE_ONLY_DAYS }).toJSDate();
    const end = a.plus({ days: config.AROUND_DATE_ONLY_DAYS }).endOf("day").toJSDate();
    return `${rangeLabel(start, end, tz, now)}${sideNote(q.dateSide)}`;
  }
  return describeSearch(w, q.dateSide);
}

function describeSearch(w: TimeWindow, s: DateSide): string {
  if (w.mode === "exact") return `${w.label} only${sideNote(s)}`;
  if (w.mode === "range") return `${w.label}${sideNote(s)}`;
  if (w.mode === "around") return `all history, weighted towards ${w.label.replace(/^around /, "")}`;
  return "all history";
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
