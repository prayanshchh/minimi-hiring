import { randomUUID } from "node:crypto";
import { config } from "./config";
import type { DB } from "./db";
import { toVector, type Embedder } from "./models";

/**
 * Exchange Store: the exact, searchable record of every exchange (user message + reply),
 * plus "observations": the web passages the reply cited, as they read at that moment.
 * This is the evidence. Memories only point here.
 */

export type Session = { id: string; userId: string; title: string; startedAt: Date };
export type Exchange = {
  id: string;
  sessionId: string;
  userId: string;
  seq: number;
  userText: string;
  userSentAt: Date;
  assistantText: string | null;
  assistantSentAt: Date | null;
  status: "pending" | "complete" | "failed";
};
export type Observation = {
  id: string;
  exchangeId: string;
  url: string;
  title: string;
  excerpt: string;
  observedAt: Date;
  searchQuery: string;
};
export type NewObservation = Omit<Observation, "id" | "exchangeId">;
export type Transcript = { session: Session; exchanges: Exchange[]; observations: Map<string, Observation[]> };

/** Short, stable label used in prompts and quotes: "ex_3f9a2c1b". */
export const exRef = (exchangeId: string) => `ex_${exchangeId.slice(0, 8)}`;

/** Ids from cookies and request bodies are checked before they reach a uuid column. */
export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ── Users & sessions ───────────────────────────────────────────────────────

export async function getOrCreateUser(db: DB, id: string | undefined, timezone: string | undefined) {
  const tz = validTimezone(timezone);
  if (isUuid(id)) { // anything else (a stale or foreign cookie) just gets a new user
    const { rows } = await db.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM users WHERE id = $1`, [id]);
    const found = rows[0];
    if (found) {
      if (tz && tz !== found.timezone) await db.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [id, tz]);
      return { id: found.id, timezone: tz ?? found.timezone };
    }
  }
  const user = { id: randomUUID(), timezone: tz ?? "UTC" };
  await db.query(`INSERT INTO users (id, timezone) VALUES ($1, $2)`, [user.id, user.timezone]);
  return user;
}

function validTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export async function listSessions(db: DB, userId: string) {
  const { rows } = await db.query<{ id: string; title: string; started_at: Date; last_at: Date }>(
    `SELECT s.id, s.title, s.started_at, coalesce(max(e.user_sent_at), s.started_at) AS last_at
       FROM sessions s LEFT JOIN exchanges e ON e.session_id = s.id
      WHERE s.user_id = $1
      GROUP BY s.id ORDER BY last_at DESC, s.id`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, startedAt: r.started_at, lastAt: r.last_at }));
}

export async function getSession(db: DB, userId: string, sessionId: string): Promise<Session | null> {
  if (!isUuid(sessionId)) return null;
  const { rows } = await db.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
  return rows[0] ? toSession(rows[0]) : null;
}

// ── Exchanges ──────────────────────────────────────────────────────────────

/**
 * Step 1, on arrival: save the user side at once (status 'pending'), creating the session
 * for a new chat. The title is the first message, truncated: no LLM call on the hot path.
 */
export async function startExchange(
  db: DB,
  input: { userId: string; sessionId: string | null; text: string; sentAt: Date },
): Promise<{ exchange: Exchange; session: Session; isNewSession: boolean }> {
  return db.transaction(async (tx) => {
    let session = isUuid(input.sessionId)
      ? (await tx.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1 AND user_id = $2`, [input.sessionId, input.userId])).rows[0]
      : undefined;
    const isNewSession = !session;
    if (!session) {
      const row: SessionRow = { id: randomUUID(), user_id: input.userId, title: titleFrom(input.text), started_at: input.sentAt };
      await tx.query(`INSERT INTO sessions (id, user_id, title, started_at) VALUES ($1, $2, $3, $4)`, [row.id, row.user_id, row.title, row.started_at]);
      session = row;
    }
    const { rows } = await tx.query<{ next: number }>(`SELECT coalesce(max(seq), 0) + 1 AS next FROM exchanges WHERE session_id = $1`, [session.id]);
    const exchange: Exchange = {
      id: randomUUID(),
      sessionId: session.id,
      userId: input.userId,
      seq: rows[0]!.next,
      userText: input.text,
      userSentAt: input.sentAt,
      assistantText: null,
      assistantSentAt: null,
      status: "pending",
    };
    await tx.query(
      `INSERT INTO exchanges (id, session_id, user_id, seq, user_text, user_sent_at, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [exchange.id, exchange.sessionId, exchange.userId, exchange.seq, exchange.userText, exchange.userSentAt],
    );
    return { exchange, session: toSession(session), isNewSession };
  });
}

/**
 * Step 2, when the reply finishes: save it, embed both sides *synchronously* (so the very next
 * message can find this exchange) and store the observations the answer cited.
 * The fts column is a generated column, so Postgres updates it in the same statement.
 */
export async function completeExchange(
  deps: { db: DB; embedder: Embedder },
  input: { exchangeId: string; userText: string; assistantText: string; sentAt: Date; observations: NewObservation[] },
): Promise<void> {
  const [embedding] = await deps.embedder.embed([embeddingText(input.userText, input.assistantText)], "document");
  await deps.db.transaction(async (tx) => {
    await tx.query(
      `UPDATE exchanges SET assistant_text = $2, assistant_sent_at = $3, status = 'complete', embedding = $4::vector WHERE id = $1`,
      [input.exchangeId, input.assistantText, input.sentAt, toVector(embedding!)],
    );
    for (const o of input.observations) {
      await tx.query(
        `INSERT INTO observations (id, exchange_id, url, title, excerpt, observed_at, search_query) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [randomUUID(), input.exchangeId, o.url, o.title, o.excerpt, o.observedAt, o.searchQuery],
      );
    }
  });
}

/** Step 3, if the reply fails: keep the user side, mark the exchange failed. */
export async function failExchange(db: DB, exchangeId: string): Promise<void> {
  await db.query(`UPDATE exchanges SET status = 'failed' WHERE id = $1`, [exchangeId]);
}

/**
 * On startup, any exchange still 'pending' belonged to a process that died mid-turn (the data
 * folder is locked to one process), so it can never complete: mark it failed.
 */
export async function failStalePending(db: DB): Promise<number> {
  const { affectedRows } = await db.query(`UPDATE exchanges SET status = 'failed' WHERE status = 'pending'`);
  return affectedRows ?? 0;
}

/** One embedding for the whole exchange: a question is usually only findable together with its answer. */
export function embeddingText(userText: string, assistantText: string): string {
  return `${userText}\n${assistantText}`.slice(0, config.EMBEDDING_MAX_CHARS); // stay inside the embedding model's input limit
}

export async function sessionExchanges(db: DB, sessionId: string, opts: { completeOnly?: boolean } = {}): Promise<Exchange[]> {
  const { rows } = await db.query<ExchangeRow>(
    `SELECT ${EXCHANGE_COLS} FROM exchanges WHERE session_id = $1 ${opts.completeOnly ? "AND status = 'complete'" : ""} ORDER BY seq`,
    [sessionId],
  );
  return rows.map(toExchange);
}

export async function getExchange(db: DB, exchangeId: string): Promise<Exchange | null> {
  const { rows } = await db.query<ExchangeRow>(`SELECT ${EXCHANGE_COLS} FROM exchanges WHERE id = $1`, [exchangeId]);
  return rows[0] ? toExchange(rows[0]) : null;
}

export async function observationsFor(db: DB, exchangeIds: string[]): Promise<Map<string, Observation[]>> {
  const map = new Map<string, Observation[]>();
  if (!exchangeIds.length) return map;
  const { rows } = await db.query<ObservationRow>(
    `SELECT * FROM observations WHERE exchange_id = ANY($1::uuid[]) ORDER BY observed_at, url, id`,
    [exchangeIds],
  );
  for (const r of rows) {
    const list = map.get(r.exchange_id) ?? [];
    list.push({ id: r.id, exchangeId: r.exchange_id, url: r.url, title: r.title, excerpt: r.excerpt, observedAt: r.observed_at, searchQuery: r.search_query });
    map.set(r.exchange_id, list);
  }
  return map;
}

/** Full transcripts (complete exchanges + observations) for the given sessions. */
export async function loadTranscripts(db: DB, sessionIds: string[]): Promise<Map<string, Transcript>> {
  const out = new Map<string, Transcript>();
  if (!sessionIds.length) return out;
  const sessions = await db.query<SessionRow>(`SELECT * FROM sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
  const exchanges = await db.query<ExchangeRow>(
    `SELECT ${EXCHANGE_COLS} FROM exchanges WHERE session_id = ANY($1::uuid[]) AND status = 'complete' ORDER BY session_id, seq`,
    [sessionIds],
  );
  const observations = await observationsFor(db, exchanges.rows.map((r) => r.id));
  for (const s of sessions.rows) out.set(s.id, { session: toSession(s), exchanges: [], observations });
  for (const r of exchanges.rows) out.get(r.session_id)?.exchanges.push(toExchange(r));
  return out;
}

// ── Row mapping ────────────────────────────────────────────────────────────

const EXCHANGE_COLS = `id, session_id, user_id, seq, user_text, user_sent_at, assistant_text, assistant_sent_at, status`;
type SessionRow = { id: string; user_id: string; title: string; started_at: Date };
type ExchangeRow = {
  id: string; session_id: string; user_id: string; seq: number; user_text: string; user_sent_at: Date;
  assistant_text: string | null; assistant_sent_at: Date | null; status: Exchange["status"];
};
type ObservationRow = { id: string; exchange_id: string; url: string; title: string; excerpt: string; observed_at: Date; search_query: string };

const toSession = (r: SessionRow): Session => ({ id: r.id, userId: r.user_id, title: r.title, startedAt: r.started_at });
export const toExchange = (r: ExchangeRow): Exchange => ({
  id: r.id, sessionId: r.session_id, userId: r.user_id, seq: r.seq, userText: r.user_text, userSentAt: r.user_sent_at,
  assistantText: r.assistant_text, assistantSentAt: r.assistant_sent_at, status: r.status,
});

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= config.SESSION_TITLE_CHARS ? oneLine : `${oneLine.slice(0, config.SESSION_TITLE_CHARS - 1).trimEnd()}…`;
}

// ── Embedding model changes ────────────────────────────────────────────────

/**
 * Vectors from two embedding models can't be compared. If the stored ones came from another model
 * (or were cleared by a resize), re-embed every exchange and memory with the current one.
 * Cheap when nothing changed: one query.
 */
export async function syncEmbeddings(deps: { db: DB; embedder: Embedder }, log: (msg: string) => void = console.log): Promise<number> {
  const { db, embedder } = deps;
  const prev = (await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'embedding_model'`)).rows[0]?.value;
  if (prev !== embedder.name) await db.exec(`UPDATE exchanges SET embedding = NULL; UPDATE memories SET embedding = NULL;`);
  const exchanges = (await db.query<{ id: string; user_text: string; assistant_text: string }>(
    `SELECT id, user_text, assistant_text FROM exchanges WHERE status = 'complete' AND embedding IS NULL ORDER BY user_sent_at, id`,
  )).rows;
  const memories = (await db.query<{ id: string; text: string }>(`SELECT id, text FROM memories WHERE embedding IS NULL ORDER BY occurred_at, id`)).rows;
  if (exchanges.length + memories.length) log(`[embeddings] embedding ${exchanges.length} exchange(s) and ${memories.length} memor${memories.length === 1 ? "y" : "ies"} with ${embedder.name}…`);
  for (let i = 0; i < exchanges.length; i += 16) {
    const batch = exchanges.slice(i, i + 16);
    const vecs = await embedder.embed(batch.map((e) => embeddingText(e.user_text, e.assistant_text ?? "")), "document");
    for (const [j, e] of batch.entries()) await db.query(`UPDATE exchanges SET embedding = $2::vector WHERE id = $1`, [e.id, toVector(vecs[j]!)]);
  }
  for (let i = 0; i < memories.length; i += 32) {
    const batch = memories.slice(i, i + 32);
    const vecs = await embedder.embed(batch.map((m) => m.text), "document");
    for (const [j, m] of batch.entries()) await db.query(`UPDATE memories SET embedding = $2::vector WHERE id = $1`, [m.id, toVector(vecs[j]!)]);
  }
  await db.query(`INSERT INTO meta (key, value) VALUES ('embedding_model', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [embedder.name]);
  return exchanges.length + memories.length;
}
