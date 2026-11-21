import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { acquireLock, openDb } from "./db";
import { assertKeys, env } from "./env";
import type { Emit } from "./events";
import { failStalePending, getOrCreateUser, getSession, isUuid, listSessions, sessionExchanges, syncEmbeddings } from "./exchangeStore";
import { listMemories, MemoryQueue } from "./memoryWriter";
import { createEmbedder, modelName } from "./models";
import { runTurn, type TurnDeps } from "./turn";

assertKeys({ web: true });
const release = acquireLock(env.DATA_DIR, "npm run dev");
const db = await openDb(env.DATA_DIR);
const embedder = createEmbedder();
// Ready the embedding model before serving. On the first start this is the ~315 MB download, with
// a progress line, so the first message doesn't wait for it.
try {
  await embedder.prepare();
} catch (err) {
  console.error(`\nCould not load the embedding model ${env.EMBEDDING_MODEL}: ${(err as Error).message}\nCheck your internet connection, then run npm run dev again.\n`);
  await db.close().catch(() => {});
  release();
  process.exit(1);
}
const memory = new MemoryQueue({ db, embedder });
const deps: TurnDeps = { db, embedder, memory };

type User = { id: string; timezone: string };
const app = new Hono<{ Variables: { user: User } }>();
const COOKIE = "uid";

// `/?seed=1` adopts the user created by `npm run seed`, so reviewers land in a ready history.
app.get("/", async (c, next) => {
  if (c.req.query("seed") !== undefined) {
    const file = path.join(env.DATA_DIR, "seed-user.json");
    if (!fs.existsSync(file)) return c.text("No seed found. Stop the server, run `npm run seed`, then start it again.", 404);
    const { userId } = JSON.parse(fs.readFileSync(file, "utf8")) as { userId: string };
    setCookie(c, COOKIE, userId, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    return c.redirect("/");
  }
  return next();
});
app.use("/*", serveStatic({ root: "./public" }));

// Anonymous user: a cookie id, created on first visit. Every query below is scoped to it.
// The browser sends its IANA timezone on every request; all date interpretation uses it.
app.use("/api/*", async (c, next) => {
  const user = await getOrCreateUser(db, getCookie(c, COOKIE), c.req.header("x-timezone"));
  setCookie(c, COOKIE, user.id, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  c.set("user", user);
  await next();
});

app.get("/api/sessions", async (c) => c.json(await listSessions(db, c.get("user").id)));

// What the Memory Writer has extracted for this user (read-only; the Memories page shows it).
app.get("/api/memories", async (c) => c.json(await listMemories(db, c.get("user").id)));

app.get("/api/sessions/:id", async (c) => {
  const session = await getSession(db, c.get("user").id, c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  const exchanges = await sessionExchanges(db, session.id);
  return c.json({
    session,
    exchanges: exchanges.map((e) => ({ id: e.id, userText: e.userText, userSentAt: e.userSentAt, assistantText: e.assistantText, status: e.status })),
  });
});

app.post("/api/chat", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ sessionId?: string | null; message?: string }>().catch(() => ({}) as { sessionId?: string; message?: string });
  const message = body.message?.trim();
  if (!message) return c.json({ error: "Empty message" }, 400);
  if (body.sessionId != null && !isUuid(body.sessionId)) return c.json({ error: "Unknown session" }, 400);

  return streamSSE(c, async (stream) => {
    // Writes are chained so events arrive in order and the last one is flushed before the stream closes.
    // If the browser goes away we still finish and store the answer; it shows up on reload.
    let writes = Promise.resolve();
    const write = (fn: () => Promise<void>) => (writes = writes.then(fn).catch(() => {}));
    const emit: Emit = (event, data) => void write(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
    const keepAlive = setInterval(() => void write(() => stream.write(": keep-alive\n\n").then(() => {})), config.SSE_KEEPALIVE_MS);
    try {
      await runTurn(deps, { userId: user.id, timezone: user.timezone, sessionId: body.sessionId ?? null, message }, emit);
    } finally {
      clearInterval(keepAlive);
      await writes;
    }
  });
});

const stale = await failStalePending(db);
await syncEmbeddings({ db, embedder }); // after an embedding-model change, re-embed what is stored
const backlog = await memory.backfill();
serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`\nChat agent on http://localhost:${port}`);
  console.log(`  models: main ${modelName("main")} (fallback ${modelName("fallback")}) · small ${modelName("small")} · embeddings ${modelName("embedding")}`);
  console.log(`  data: ${path.resolve(env.DATA_DIR)}`);
  if (stale) console.log(`  ${stale} exchange(s) left pending by a previous run marked failed`);
  if (backlog) console.log(`  memory backfill: ${backlog} exchange(s) queued`);
  if (fs.existsSync(path.join(env.DATA_DIR, "seed-user.json"))) console.log(`  seeded history: open http://localhost:${port}/?seed=1`);
});

async function shutdown() {
  await db.close().catch(() => {});
  release();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
