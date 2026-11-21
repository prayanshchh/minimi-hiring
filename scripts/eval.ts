import fs from "node:fs";
import { answer } from "../src/answerer";
import { buildPrompt } from "../src/promptBuilder";
import { openDb } from "../src/db";
import { assertKeys } from "../src/env";
import { completeExchange, sessionExchanges, startExchange } from "../src/exchangeStore";
import { createEmbedder, modelName, toVector } from "../src/models";
import { plan } from "../src/planner";
import { retrieve, type RetrievalResult } from "../src/retriever";
import { seedDatabase, type SeedTimeline } from "./scenarios";

/**
 * `npm run eval` — seeds the scenarios into a throwaway in-memory database, then for each case runs
 * the real Planner + Retriever (+ Packer) and asserts on what was retrieved: which sessions, which
 * exchanges, which status. It also prints the Answerer's reply (real web search) for manual review.
 *   --no-answers   retrieval assertions only (fast, no Exa calls)
 *   --only=name    run one case
 *   --write        also write the pass/fail table into README.md (between the eval markers)
 */
const args = process.argv.slice(2);
const withAnswers = !args.includes("--no-answers");
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
assertKeys({ web: withAnswers });

type Expect = {
  status?: RetrievalResult["status"];
  include?: string[];
  exclude?: string[];
  nearest?: string;
  /** Long session whose last exchange (where its decision is) must be matched, and its memories handed over. */
  lastWindow?: { key: string; n: number };
};
type Case = { name: string; message: (t: SeedTimeline) => string; expect: Expect; look: string };

const day = (d: { toFormat(f: string): string }) => d.toFormat("cccc d LLLL");
const CASES: Case[] = [
  { name: "crm-current", message: () => "What's on our current CRM shortlist for the sales team?", expect: { status: "found", include: ["crmMonday", "crmRevision"] }, look: "the revised list (Salesforce Starter instead of Close)" },
  { name: "crm-on-monday", message: () => "What was our CRM shortlist on Monday?", expect: { status: "found", include: ["crmMonday"], exclude: ["crmRevision"] }, look: "the original Monday list, with Close" },
  { name: "crm-changed-since", message: () => "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", expect: { status: "found", include: ["crmMonday"], exclude: ["crmRevision"] }, look: "per-vendor verdicts vs Monday's snapshots; Pipedrive plan rename check" },
  { name: "proposal-not-decision", message: () => "Did we decide to drop Freshsales from the CRM shortlist?", expect: { status: "found", include: ["crmMonday"] }, look: "it was only my suggestion; the user never agreed" },
  { name: "postgres-last-tuesday", message: () => "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", expect: { status: "found", include: ["postgresTuesday"], exclude: ["postgresEarlier"] }, look: "'my earlier answer was wrong' for Supabase ($20 said, $25 observed)" },
  { name: "none-on-date", message: () => "What did I ask you about email marketing tools on Tuesday?", expect: { status: "none_on_date", nearest: "emailThursday" }, look: "nothing on Tuesday; offers the Thursday chat" },
  { name: "long-session-last", message: () => "What did we finally decide about the offsite venue?", expect: { status: "found", include: ["offsite"], lastWindow: { key: "offsite", n: 3 } }, look: "LX Factory, Lisbon, 14–16 April (the final exchange)" },
  { name: "midnight-user-side", message: (t) => `What did I ask you on ${day(t.midnightAsk.plus({ days: 1 }))}?`, expect: { exclude: ["midnight"] }, look: "the pgbouncer question is NOT listed (it was asked on Monday)" },
  { name: "midnight-assistant-side", message: (t) => `What did you tell me on ${day(t.midnightAsk.plus({ days: 1 }))}?`, expect: { status: "found", include: ["midnight"] }, look: "includes the pgbouncer answer (sent 00:01)" },
  { name: "midnight-either-side", message: (t) => `What did we discuss on ${day(t.midnightAsk)}?`, expect: { status: "found", include: ["midnight"] }, look: "includes the pgbouncer chat" },
  { name: "dated-question", message: (t) => `What did I ask you on ${t.datedQuestion.toFormat("d LLLL")}? Is your answer still correct today?`, expect: { status: "found", include: ["datedQuestion"] }, look: "the Python question, re-verified" },
  { name: "no-match", message: () => "What did we decide about Kubernetes autoscaling?", expect: { status: "no_match" }, look: "says nothing was found; never invents a chat" },
];

const db = await openDb(); // in memory: the eval never touches ./data
const deps = { db, embedder: createEmbedder() };
const timezone = process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();
console.log(`Seeding scenarios (timezone ${timezone})…`);
const seed = await seedDatabase(deps, { now, timezone });
const keyOf = new Map(Object.entries(seed.sessionIds).map(([k, v]) => [v, k]));

const summary: Array<{ name: string; ok: boolean; detail: string }> = [];
const sims = { onTopicMin: Infinity, offTopicMax: -Infinity };

for (const c of CASES.filter((c) => !only || c.name === only)) {
  const message = c.message(seed.timeline);
  const planned = await plan({ message, recent: [], timezone, now });
  const results = await retrieve(deps, { userId: seed.userId, currentSessionId: null, timezone, now, questions: planned.questions });
  const prompt = buildPrompt({ message, timezone, now, needsWeb: planned.plan.needsWeb, questions: planned.questions, results, currentChat: [] });

  const checks = check(c.expect, results);
  const ok = checks.every((x) => x.ok);
  summary.push({ name: c.name, ok, detail: checks.filter((x) => !x.ok).map((x) => x.label).join("; ") });

  console.log(`\n━━ ${c.name} ${"━".repeat(Math.max(2, 60 - c.name.length))}`);
  console.log(`Q: ${message}`);
  for (const q of planned.questions) console.log(`plan: ${q.queryId} memory=${q.needsMemory} window=${q.window.mode}${"label" in q.window ? `(${q.window.label})` : ""} side=${q.dateSide} keywords=[${q.keywords.join(", ")}]${q.dateOnly ? " date-only" : ""}`);
  for (const r of results) console.log(`retrieval: ${r.queryId} ${r.status} · searched ${r.searched} · ${r.sessions.map((s) => `${keyOf.get(s.sessionId)}(${s.date}, ${s.matches.length} match)`).join(", ") || "-"}${r.nearestElsewhere ? ` · nearest: ${keyOf.get(r.nearestElsewhere.sessionId)} (${r.nearestElsewhere.date})` : ""}`);
  console.log(`checks: ${checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.label}`).join("  ")}`);
  const sim = await similarityReport(c.expect, planned.questions);
  if (sim) console.log(sim);

  if (withAnswers) {
    const searches: string[] = [];
    const pastDates = [...new Set(results.flatMap((r) => r.sessions.map((s) => s.date)))];
    try {
      const reply = await answer({ db, prompt, timezone, now, pastDates, emit: (e, d) => e === "web.search" && searches.push((d as { query: string }).query) });
      console.log(`web: ${searches.map((s) => `"${s}"`).join(", ") || "(no searches)"}`);
      console.log(`look for: ${c.look}\n${indent(reply.text)}`);
    } catch (err) {
      console.log(`answer failed: ${(err as Error).message}`);
    }
  }
}

// 7. Follow-up in the same chat: retrieval runs again and returns the same sessions.
if (!only || only === "follow-up") {
  const first = "What's on our CRM shortlist?";
  const { exchange, session } = await startExchange(db, { userId: seed.userId, sessionId: null, text: first, sentAt: now });
  const q1 = await plan({ message: first, recent: [], timezone, now });
  const r1 = await retrieve(deps, { userId: seed.userId, currentSessionId: session.id, timezone, now, questions: q1.questions });
  await completeExchange(deps, { exchangeId: exchange.id, userText: first, assistantText: "Your current shortlist is HubSpot Sales Hub, Pipedrive, Salesforce Starter, Zoho CRM and Freshsales.", sentAt: now, observations: [] });

  const second = "Why did we replace Close?";
  const recent = await sessionExchanges(db, session.id, { completeOnly: true });
  const q2 = await plan({ message: second, recent, timezone, now });
  const r2 = await retrieve(deps, { userId: seed.userId, currentSessionId: session.id, timezone, now, questions: q2.questions });
  const r2again = await retrieve(deps, { userId: seed.userId, currentSessionId: session.id, timezone, now, questions: q2.questions });

  const set = (rs: RetrievalResult[]) => [...new Set(rs.flatMap((r) => r.sessions.map((s) => keyOf.get(s.sessionId) ?? "?")))].sort();
  const checks = [
    { label: "turn 2 searched history", ok: q2.questions.some((q) => q.needsMemory) },
    { label: "turn 2 includes Monday + revision", ok: ["crmMonday", "crmRevision"].every((k) => set(r2).includes(k)) },
    { label: "same sessions as turn 1", ok: JSON.stringify(set(r1)) === JSON.stringify(set(r2)) },
    { label: "deterministic re-run", ok: JSON.stringify(r2) === JSON.stringify(r2again) },
  ];
  console.log(`\n━━ follow-up ${"━".repeat(50)}\nturn 1: ${first} → ${set(r1).join(", ")}\nturn 2: ${second} → ${set(r2).join(", ")}`);
  console.log(`checks: ${checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.label}`).join("  ")}`);
  summary.push({ name: "follow-up", ok: checks.every((x) => x.ok), detail: checks.filter((x) => !x.ok).map((x) => x.label).join("; ") });
}

console.log(`\n${"━".repeat(64)}\nRetrieval assertions`);
for (const s of summary) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name.padEnd(26)} ${s.detail}`);
console.log(`  ${summary.filter((s) => s.ok).length}/${summary.length} passed`);
if (Number.isFinite(sims.onTopicMin) && Number.isFinite(sims.offTopicMax)) {
  const floor = deps.embedder.minSimilarity;
  console.log(`\nVector floor (${deps.embedder.name}): current ${floor}. Lowest on-topic best match ${sims.onTopicMin.toFixed(3)}, highest off-topic best match ${sims.offTopicMax.toFixed(3)}.`);
  console.log(
    sims.onTopicMin > sims.offTopicMax
      ? `  Separable: any floor between them works; the midpoint is ${((sims.onTopicMin + sims.offTopicMax) / 2).toFixed(2)} (config.VECTOR_MIN_SIMILARITY).`
      : "  Not separable by vector similarity alone here; the keyword-coverage path of the floor has to carry those cases.",
  );
}
if (args.includes("--write")) writeEvalSummary();
await db.close();
process.exit(summary.every((s) => s.ok) ? 0 : 1);

/**
 * Tuning aid for the vector half of the relevance floor: the best cosine similarity of the planned
 * query to each seeded session (exchanges and memories), split into on-topic sessions (the ones the
 * case expects or excludes by date) and off-topic ones.
 */
async function similarityReport(e: Expect, questions: Awaited<ReturnType<typeof plan>>["questions"]): Promise<string | null> {
  const q = questions.find((x) => x.needsMemory && !x.dateOnly);
  if (!q) return null;
  const onTopic = new Set([...(e.include ?? []), ...(e.exclude ?? []), ...(e.nearest ? [e.nearest] : [])]);
  const [vec] = await deps.embedder.embed([q.query], "query");
  const { rows } = await db.query<{ session_id: string; sim: number }>(
    `SELECT session_id, max(sim) AS sim FROM (
       SELECT session_id, 1 - (embedding <=> $1::vector) AS sim FROM exchanges WHERE user_id = $2 AND embedding IS NOT NULL
       UNION ALL
       SELECT session_id, 1 - (embedding <=> $1::vector) AS sim FROM memories WHERE user_id = $2 AND embedding IS NOT NULL
     ) t GROUP BY session_id`,
    [toVector(vec!), seed.userId],
  );
  const on = rows.filter((r) => onTopic.has(keyOf.get(r.session_id) ?? "")).map((r) => r.sim);
  const off = rows.filter((r) => keyOf.has(r.session_id) && !onTopic.has(keyOf.get(r.session_id)!)).map((r) => r.sim);
  if (on.length) sims.onTopicMin = Math.min(sims.onTopicMin, ...on);
  if (off.length) sims.offTopicMax = Math.max(sims.offTopicMax, ...off);
  const fmt = (xs: number[], pick: (...n: number[]) => number) => (xs.length ? pick(...xs).toFixed(3) : "-");
  return `similarity: on-topic min ${fmt(on, Math.min)} · off-topic max ${fmt(off, Math.max)} · floor ${deps.embedder.minSimilarity}`;
}

function check(e: Expect, results: RetrievalResult[]) {
  const out: Array<{ label: string; ok: boolean }> = [];
  const found = new Set(results.flatMap((r) => r.sessions.map((s) => keyOf.get(s.sessionId))));
  if (e.status) out.push({ label: `status ${e.status}`, ok: results.some((r) => r.status === e.status) });
  for (const k of e.include ?? []) out.push({ label: `includes ${k}`, ok: found.has(k) });
  for (const k of e.exclude ?? []) out.push({ label: `excludes ${k}`, ok: !found.has(k) });
  if (e.nearest) out.push({ label: `nearest elsewhere = ${e.nearest}`, ok: results.some((r) => r.nearestElsewhere && keyOf.get(r.nearestElsewhere.sessionId) === e.nearest) });
  if (e.lastWindow) {
    const ids = seed.exchangeIds[e.lastWindow.key]!;
    const matchedLast = results.some((r) => r.sessions.some((s) => s.matches.some((m) => m.exchangeId === ids.at(-1))));
    out.push({ label: "last exchange matched", ok: matchedLast });
    out.push({ label: "its memories reach the Answerer", ok: results.some((r) => r.memories.some((m) => m.exchangeId === ids.at(-1))) });
  }
  return out;
}

function writeEvalSummary() {
  const file = new URL("../README.md", import.meta.url);
  const doc = fs.readFileSync(file, "utf8");
  if (!/<!-- eval:start -->[\s\S]*<!-- eval:end -->/.test(doc)) {
    console.warn("README.md has no <!-- eval:start --> / <!-- eval:end --> markers; table not written.");
    return;
  }
  const table = [
    `Last run: ${now.toISOString().slice(0, 10)}, ${modelName("small")} planner, ${summary.filter((s) => s.ok).length}/${summary.length} retrieval cases passed.`,
    "",
    "| Case | Result | Failed checks |",
    "|---|---|---|",
    ...summary.map((s) => `| ${s.name} | ${s.ok ? "pass" : "**fail**"} | ${s.detail || ""} |`),
  ].join("\n");
  const updated = doc.replace(/<!-- eval:start -->[\s\S]*<!-- eval:end -->/, `<!-- eval:start -->\n${table}\n<!-- eval:end -->`);
  fs.writeFileSync(file, updated);
  console.log("README.md eval summary updated.");
}

function indent(s: string) {
  return s.split("\n").map((l) => `    ${l}`).join("\n");
}
