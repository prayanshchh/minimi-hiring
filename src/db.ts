import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

/**
 * PGlite = real Postgres (18) compiled to WASM, running in-process. No Docker, no server,
 * and we still get pgvector, full-text search, generated columns and transactions.
 */
export type DB = PGlite;

const D = config.EMBEDDING_DIMENSIONS;

export const SCHEMA = /* sql */ `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY,
  timezone    text NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  started_at  timestamptz NOT NULL
);

-- The exact conversation record. One row = one user message + the reply to it.
CREATE TABLE IF NOT EXISTS exchanges (
  id                 uuid PRIMARY KEY,
  session_id         uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq                int  NOT NULL,
  user_text          text NOT NULL,
  user_sent_at       timestamptz NOT NULL,
  assistant_text     text,
  assistant_sent_at  timestamptz,
  status             text NOT NULL CHECK (status IN ('pending','complete','failed')),
  embedding          vector(${D}),            -- embedding of user_text + "\\n" + assistant_text
  -- Keyword index of both sides, kept in sync by Postgres itself. User side weighted higher.
  fts tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(user_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(assistant_text, '')), 'B')
  ) STORED,
  extracted_at       timestamptz,
  extractor_version  int,
  UNIQUE (session_id, seq)
);

-- What the agent saw on the web when it answered: the baseline for "has it changed since?".
CREATE TABLE IF NOT EXISTS observations (
  id            uuid PRIMARY KEY,
  exchange_id   uuid NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  url           text NOT NULL,
  title         text NOT NULL,
  excerpt       text NOT NULL,
  observed_at   timestamptz NOT NULL,
  search_query  text NOT NULL
);

-- Self-contained facts. An index into exchanges, never a replacement for them.
CREATE TABLE IF NOT EXISTS memories (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exchange_id  uuid NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('preference','decision','request')),  -- a fact the user stated, a decision, or what they asked
  speaker      text NOT NULL CHECK (speaker IN ('user','assistant')),  -- always 'user' since extractor v2
  topic        text NOT NULL,
  entities     text[] NOT NULL DEFAULT '{}',
  text         text NOT NULL,
  source_url   text,
  hash         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  embedding    vector(${D}),
  fts          tsvector NOT NULL,
  UNIQUE (user_id, hash)                     -- exact-duplicate removal
);

-- Data folders created before the "request" kind existed: widen the check (idempotent).
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_kind_check;
ALTER TABLE memories ADD CONSTRAINT memories_kind_check CHECK (kind IN ('preference','decision','request'));

-- Which embedding model made the stored vectors (vectors from different models can't be compared).
CREATE TABLE IF NOT EXISTS meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx        ON sessions (user_id, started_at);
CREATE INDEX IF NOT EXISTS exchanges_user_idx       ON exchanges (user_id);
CREATE INDEX IF NOT EXISTS exchanges_session_idx    ON exchanges (session_id, seq);
CREATE INDEX IF NOT EXISTS exchanges_user_sent_idx  ON exchanges (user_id, user_sent_at);
CREATE INDEX IF NOT EXISTS exchanges_asst_sent_idx  ON exchanges (user_id, assistant_sent_at);
CREATE INDEX IF NOT EXISTS exchanges_fts_idx        ON exchanges USING gin (fts);
CREATE INDEX IF NOT EXISTS exchanges_embedding_idx  ON exchanges USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS observations_exchange_idx ON observations (exchange_id);
CREATE INDEX IF NOT EXISTS memories_user_idx        ON memories (user_id);
CREATE INDEX IF NOT EXISTS memories_exchange_idx    ON memories (exchange_id);
CREATE INDEX IF NOT EXISTS memories_session_idx     ON memories (session_id);
CREATE INDEX IF NOT EXISTS memories_occurred_idx    ON memories (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS memories_fts_idx         ON memories USING gin (fts);
CREATE INDEX IF NOT EXISTS memories_embedding_idx   ON memories USING hnsw (embedding vector_cosine_ops);
`;

/**
 * Opens the database (in memory when dataDir is undefined) and applies the schema.
 * Vector search uses HNSW with pgvector 0.8 iterative scans in strict order, so a filtered
 * query (one user, one date window) still returns the true nearest rows, in a stable order.
 */
export async function openDb(dataDir?: string): Promise<DB> {
  const db = dataDir
    ? await PGlite.create(path.resolve(dataDir, "pg"), { extensions: { vector } })
    : await PGlite.create({ extensions: { vector } });
  await db.exec(SCHEMA);
  await resizeVectors(db);
  await db.exec(`SET hnsw.iterative_scan = strict_order; SET hnsw.ef_search = 200;`);
  return db;
}

/**
 * A data folder made with another vector size (the 1536-number Gemini vectors used before
 * EmbeddingGemma): resize both vector columns and clear them. `syncEmbeddings` re-embeds at startup.
 */
async function resizeVectors(db: DB): Promise<void> {
  const { rows } = await db.query<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'exchanges'::regclass AND attname = 'embedding'`,
  );
  if (!rows[0] || rows[0].dims === D) return;
  await db.exec(`
    DROP INDEX IF EXISTS exchanges_embedding_idx;
    DROP INDEX IF EXISTS memories_embedding_idx;
    ALTER TABLE exchanges ALTER COLUMN embedding TYPE vector(${D}) USING NULL;
    ALTER TABLE memories  ALTER COLUMN embedding TYPE vector(${D}) USING NULL;
    CREATE INDEX exchanges_embedding_idx ON exchanges USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX memories_embedding_idx  ON memories  USING hnsw (embedding vector_cosine_ops);
  `);
  console.log(`[db] vectors resized from ${rows[0].dims} to ${D} numbers; they are re-embedded at startup`);
}

/**
 * PGlite is single-process: two processes on one data folder would corrupt it.
 * A pid lockfile turns that into a clear error ("stop npm run dev before seeding").
 */
export function acquireLock(dataDir: string, owner: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, ".lock");
  if (fs.existsSync(file)) {
    const { pid, owner: other } = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; owner: string };
    if (pid !== process.pid && isAlive(pid)) {
      console.error(`\n${dataDir} is in use by "${other}" (pid ${pid}). Stop it first, then run this again.\n`);
      process.exit(1);
    }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, owner }));
  return () => fs.rmSync(file, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
