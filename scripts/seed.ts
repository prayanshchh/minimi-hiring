import fs from "node:fs";
import path from "node:path";
import { acquireLock, openDb } from "../src/db";
import { assertKeys, env } from "../src/env";
import { syncEmbeddings } from "../src/exchangeStore";
import { createEmbedder } from "../src/models";
import { dayTimeLabel } from "../src/time";
import { seedDatabase } from "./scenarios";

/**
 * `npm run seed`: creates a user with a dated history (relative to today) and prints how to open it.
 * Re-running replaces the previous seeded user. Stop `npm run dev` first (PGlite is single-process).
 */
assertKeys({ web: false });
const release = acquireLock(env.DATA_DIR, "npm run seed");
const db = await openDb(env.DATA_DIR);
const timezone = process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const seedFile = path.join(env.DATA_DIR, "seed-user.json");

if (fs.existsSync(seedFile)) {
  const { userId } = JSON.parse(fs.readFileSync(seedFile, "utf8")) as { userId: string };
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades to sessions, exchanges, memories
}

console.log(`Seeding history for timezone ${timezone}…`);
const t0 = Date.now();
const embedder = createEmbedder();
await syncEmbeddings({ db, embedder }); // re-embeds an older folder first, and records the model
const seed = await seedDatabase({ db, embedder }, { now: new Date(), timezone, onProgress: (m) => console.log(`  ${m}`) });
fs.writeFileSync(seedFile, JSON.stringify({ userId: seed.userId, timezone, seededAt: new Date().toISOString() }, null, 2));

const { rows } = await db.query<{ title: string; started_at: Date; n: number; memories: number }>(
  `SELECT s.title, s.started_at, count(DISTINCT e.id)::int AS n, count(m.id)::int AS memories
     FROM sessions s JOIN exchanges e ON e.session_id = s.id LEFT JOIN memories m ON m.exchange_id = e.id
    WHERE s.user_id = $1 GROUP BY s.id ORDER BY s.started_at`,
  [seed.userId],
);
const now = new Date();
console.log(`\nSeeded ${rows.length} sessions in ${((Date.now() - t0) / 1000).toFixed(0)}s:`);
for (const r of rows) console.log(`  ${dayTimeLabel(r.started_at, timezone, now).padEnd(18)} ${r.title.slice(0, 60).padEnd(61)} ${r.n} exchanges, ${r.memories} memories`);

const t = seed.timeline;
const day = (d: { toFormat(f: string): string }) => d.toFormat("d LLLL");
console.log(`
Next: npm run dev, then open http://localhost:${env.PORT}/?seed=1 (sets the seeded user's cookie).
Things to ask:
  - On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?
  - What was the CRM shortlist on Monday? And what's the current one?
  - Did we decide to drop Freshsales?
  - Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?
  - What did I ask about email marketing tools on Tuesday?
  - What did we finally decide about the offsite venue?
  - What did I ask you on ${day(t.midnightAsk.plus({ days: 1 }))}?  /  What did you tell me on ${day(t.midnightAsk.plus({ days: 1 }))}?
  - What did I ask you on ${day(t.datedQuestion)}? Is your answer still correct today?
`);
await db.close();
release();
