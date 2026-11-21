import { generateText, Output } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import type { DB } from "./db";
import { exRef, getExchange, toExchange } from "./exchangeStore";
import { cacheControl, memoryWriterOptions, model, toVector, type Embedder } from "./models";
import { MEMORY_WRITER_SYSTEM, memoryWriterUserPrompt } from "./prompts/memoryWriter";
import { local } from "./time";

/**
 * Memory Writer (background, after the reply). A memory is the USER's words, never the assistant's:
 *   preference  a fact the user stated about themselves (name, likes, situation, needs)
 *   decision    something the user decided, with the full result and the date
 *   request     what the user asked or asked for in that message, with the date
 * Each points back to its exchange. Every memory must quote the user's own words in this message,
 * and code checks the quote: so nothing comes from the assistant's reply, earlier messages or other
 * chats. An assistant's suggestion is saved only once the user accepts it, as the final version.
 */

const MemorySchema = z.object({
  memories: z.array(
    z.object({
      kind: z.enum(["preference", "decision", "request"]),
      topic: z.string(),
      entities: z.array(z.string()),
      text: z.string(),
      quote: z.string().describe("The user's own words in THIS message that state the fact or the decision, copied exactly."),
    }),
  ),
});

/** Lowercase, straight quotes and dashes, single spaces: a quote must match the message, not its typography. */
const normalise = (s: string) =>
  s.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/** True when every part of the quote (split at "..." if the model joined two passages) is in the user's message. */
export function quotedFromUser(quote: string, userText: string): boolean {
  const message = normalise(userText);
  const parts = quote.split(/\.\.\.|…/).map((p) => normalise(p).replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, "")).filter(Boolean);
  return parts.length > 0 && parts.join("").length >= 3 && parts.every((p) => message.includes(p));
}

export type MemoryJob = {
  exchangeId: string;
  /** Exchanges the Retriever returned for this turn, to resolve "yesterday's list". Empty on backfill. */
  relatedExchangeIds: string[];
};

type Deps = { db: DB; embedder: Embedder };

/** Extracts and stores memories for one exchange. Idempotent: re-running replaces that exchange's memories. */
export async function writeMemories(deps: Deps, job: MemoryJob): Promise<number> {
  const { db } = deps;
  const ex = await getExchange(db, job.exchangeId);
  if (!ex || ex.status !== "complete") return 0;
  const tz = (await db.query<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [ex.userId])).rows[0]?.timezone ?? "UTC";
  const when = (d: Date) => local(d, tz).toFormat("ccc d LLL yyyy HH:mm");

  const history = (
    await db.query(
      `SELECT * FROM (SELECT * FROM exchanges WHERE session_id = $1 AND seq < $2 AND status = 'complete' ORDER BY seq DESC LIMIT $3) t ORDER BY seq`,
      [ex.sessionId, ex.seq, config.MEMORY_SESSION_HISTORY],
    )
  ).rows.map((r) => toExchange(r as never));
  const related = job.relatedExchangeIds.length
    ? (
        await db.query<{ title: string; user_text: string; assistant_text: string; user_sent_at: Date }>(
          `SELECT s.title, e.user_text, e.assistant_text, e.user_sent_at FROM exchanges e JOIN sessions s ON s.id = e.session_id
            WHERE e.id = ANY($1::uuid[]) AND e.session_id <> $2 ORDER BY e.user_sent_at, e.id`,
          [job.relatedExchangeIds, ex.sessionId],
        )
      ).rows
    : [];
  // Nearest existing memories by the exchange's own (already stored) embedding: no extra API call.
  const existing = (
    await db.query<{ text: string }>(
      `SELECT m.text FROM memories m WHERE m.user_id = $1 AND m.exchange_id <> $2 AND m.embedding IS NOT NULL
        ORDER BY m.embedding <=> (SELECT embedding FROM exchanges WHERE id = $2), m.id LIMIT $3`,
      [ex.userId, ex.id, config.MEMORY_SIMILAR_EXISTING],
    )
  ).rows;

  const prompt = memoryWriterUserPrompt({
    exchange: [
      `[${exRef(ex.id)}] user (${when(ex.userSentAt)}): ${ex.userText}`,
      `assistant (${when(ex.assistantSentAt!)}): ${ex.assistantText}`,
    ].join("\n"),
    sessionHistory: history.map((h) => `user (${when(h.userSentAt)}): ${h.userText}\nassistant: ${h.assistantText}`).join("\n"),
    related: related.map((r) => `Session "${r.title}", ${when(r.user_sent_at)}\nuser: ${r.user_text}\nassistant: ${r.assistant_text}`).join("\n\n"),
    existing: existing.map((m, i) => `"${i}": ${m.text}`).join("\n"), // small ids, never UUIDs (mem0's trick)
  });

  const { output } = await generateText({
    model: model("small"),
    system: { role: "system", content: MEMORY_WRITER_SYSTEM, providerOptions: cacheControl("small") },
    prompt,
    output: Output.object({ schema: MemorySchema }),
    providerOptions: memoryWriterOptions(), // thinks a little: runs after the reply, so no one waits
    maxRetries: 0, // the queue retries with backoff, and the model falls back
    abortSignal: AbortSignal.timeout(60_000),
  });

  // Only what the user said in this message: a memory whose quote isn't in it came from somewhere else.
  const quoted = output.memories.filter((m) => {
    if (quotedFromUser(m.quote, ex.userText)) return true;
    console.log(`[memory] ${exRef(ex.id)}: dropped "${m.text}" (its quote is not in the user's message)`);
    return false;
  });
  // Exact-duplicate removal by hash of the normalised text (within this batch and, via the unique index, across the user).
  const seen = new Set<string>();
  const rows = quoted
    .map((m) => ({ ...m, text: m.text.trim(), hash: hash(m.text) }))
    .filter((m) => m.text && !seen.has(m.hash) && seen.add(m.hash));
  const vectors = rows.length ? await deps.embedder.embed(rows.map((m) => m.text), "document") : [];

  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM memories WHERE exchange_id = $1`, [ex.id]);
    for (const [i, m] of rows.entries()) {
      await tx.query(
        `INSERT INTO memories (id, user_id, session_id, exchange_id, kind, speaker, topic, entities, text, source_url, hash, occurred_at, embedding, fts)
         VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8, NULL, $9, $10, $11::vector,
                 to_tsvector('english', $6 || ' ' || $8 || ' ' || array_to_string($7::text[], ' ')))
         ON CONFLICT (user_id, hash) DO NOTHING`,
        [randomUUID(), ex.userId, ex.sessionId, ex.id, m.kind, m.topic, m.entities, m.text, m.hash, ex.userSentAt, toVector(vectors[i]!)],
      );
    }
    await tx.query(`UPDATE exchanges SET extracted_at = now(), extractor_version = $2 WHERE id = $1`, [ex.id, config.EXTRACTOR_VERSION]);
  });
  return rows.length;
}

/** Every memory of one user, oldest first, with the chat it came from (for the Memories page). */
export async function listMemories(db: DB, userId: string) {
  const { rows } = await db.query<{
    id: string; exchange_id: string; session_id: string; session_title: string; kind: string; speaker: string;
    topic: string; entities: string[]; text: string; source_url: string | null; occurred_at: Date;
  }>(
    `SELECT m.id, m.exchange_id, m.session_id, s.title AS session_title, m.kind, m.speaker, m.topic, m.entities, m.text, m.source_url, m.occurred_at
       FROM memories m JOIN sessions s ON s.id = m.session_id
      WHERE m.user_id = $1
      ORDER BY m.occurred_at, m.id`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id, exchange: exRef(r.exchange_id), sessionId: r.session_id, sessionTitle: r.session_title, kind: r.kind, speaker: r.speaker,
    topic: r.topic, entities: r.entities, text: r.text, sourceUrl: r.source_url, occurredAt: r.occurred_at,
  }));
}

function hash(text: string): string {
  return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

/**
 * In-process queue: one job at a time (PGlite is single-connection anyway), 3 attempts with
 * exponential backoff. A job that still fails keeps extracted_at NULL and is retried by the
 * startup backfill, so a crash or outage never loses an exchange's memories.
 */
export class MemoryQueue {
  private jobs: MemoryJob[] = [];
  private running: Promise<void> | null = null;

  constructor(private deps: Deps) {}

  enqueue(job: MemoryJob): void {
    this.jobs.push(job);
    this.kick();
  }

  private kick(): void {
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.jobs.length) this.kick();
    });
  }

  /** Re-queues every complete exchange without memories from the current extractor version. */
  async backfill(): Promise<number> {
    const { rows } = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM exchanges WHERE status = 'complete' AND (extracted_at IS NULL OR extractor_version < $1) ORDER BY user_sent_at, id`,
      [config.EXTRACTOR_VERSION],
    );
    for (const r of rows) this.enqueue({ exchangeId: r.id, relatedExchangeIds: [] });
    return rows.length;
  }

  /** Resolves when the queue is empty (used by the seed script and the eval). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    while (this.jobs.length) {
      const job = this.jobs.shift()!;
      for (let attempt = 1; attempt <= config.MEMORY_MAX_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        try {
          const n = await writeMemories(this.deps, job);
          console.log(`[memory] ${exRef(job.exchangeId)}: ${n} memories (${Date.now() - t0}ms)`);
          break;
        } catch (err) {
          console.warn(`[memory] ${exRef(job.exchangeId)} attempt ${attempt} failed: ${(err as Error).message}`);
          if (attempt < config.MEMORY_MAX_ATTEMPTS) await sleep(config.MEMORY_BACKOFF_MS * 2 ** (attempt - 1));
        }
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
