import { DateTime } from "luxon";
import { config } from "../src/config";
import { openDb, type DB } from "../src/db";
import { completeExchange, getOrCreateUser, startExchange } from "../src/exchangeStore";
import type { Embedder } from "../src/models";
import { resolveQuestion, type PlannedQuestion, type ResolvedQuestion } from "../src/planner";

export const TZ = "Asia/Kolkata";
export const NOW = DateTime.fromISO("2026-11-19T14:00:00", { zone: TZ }).toJSDate(); // Thu 19 Nov 2026
export const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();

/**
 * Deterministic stand-in for the embedding model: hashed bag of (crudely stemmed) words,
 * L2-normalised. Texts sharing words are similar; unrelated texts are near-orthogonal.
 */
export const fakeEmbedder: Embedder = {
  name: "fake",
  minSimilarity: 0.35,
  embed: async (texts) =>
  texts.map((t) => {
    const v = new Array<number>(config.EMBEDDING_DIMENSIONS).fill(0);
    for (const raw of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (STOP.has(raw)) continue;
      const w = raw.replace(/(ing|es|s)$/, "");
      let h = 2166136261;
      for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      v[Math.abs(h) % v.length]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }),
};
const STOP = new Set("the a an and or of to in on for with is are was we i you it this that what did do my me".split(" "));

export async function testDb() {
  const db = await openDb();
  const user = await getOrCreateUser(db, undefined, TZ);
  return { db, userId: user.id };
}

/** Writes a session through the real Exchange Store, with explicit timestamps. */
export async function addSession(
  db: DB,
  userId: string,
  exchanges: Array<{ user: string; assistant: string; at: Date; repliedAt?: Date }>,
): Promise<{ sessionId: string; exchangeIds: string[] }> {
  let sessionId: string | null = null;
  const exchangeIds: string[] = [];
  for (const e of exchanges) {
    const { exchange, session } = await startExchange(db, { userId, sessionId, text: e.user, sentAt: e.at });
    sessionId = session.id;
    await completeExchange({ db, embedder: fakeEmbedder }, {
      exchangeId: exchange.id, userText: e.user, assistantText: e.assistant,
      sentAt: e.repliedAt ?? new Date(e.at.getTime() + 60_000), observations: [],
    });
    exchangeIds.push(exchange.id);
  }
  return { sessionId: sessionId!, exchangeIds };
}

export function question(q: Partial<PlannedQuestion> & { query: string }, raw = q.query): ResolvedQuestion {
  return resolveQuestion(
    { queryId: "q1", needsMemory: true, keywords: [], timePhrase: null, timeRefersTo: q.timePhrase ? "conversation" : null, dateSide: "either", wantsCurrent: false, allMemories: false, ...q },
    raw,
    TZ,
    NOW,
  );
}
