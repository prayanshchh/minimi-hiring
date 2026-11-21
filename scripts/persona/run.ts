import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { acquireLock, openDb } from "../../src/db";
import { assertKeys } from "../../src/env";
import type { AgentEvents } from "../../src/events";
import { getOrCreateUser, syncEmbeddings } from "../../src/exchangeStore";
import { MemoryQueue } from "../../src/memoryWriter";
import { createEmbedder, modelName } from "../../src/models";
import { runTurn } from "../../src/turn";
import { dataset, TIMEZONE, type Msg } from "./dataset";

/**
 * Replays a persona dataset through the real agent (Planner → Retriever → Answerer with web search →
 * Memory Writer), each history message at its own past date, then the test chats now.
 * Writes everything to <dir>/run.json, with each message's expectations and its Anthropic usage.
 * Uses its own data folder, never ./data. Re-running starts from an empty folder.
 *   npx tsx scripts/persona/run.ts [--set=riya|hard] [--dir=./data-persona] [--tests-at=2026-11-21T17:20]
 */
assertKeys({ web: true });
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const set = arg("set") ?? "riya";
const dir = arg("dir") ?? (set === "riya" ? "./data-persona" : `./data-persona-${set}`);
const { chats, tests } = dataset(set);

// Anthropic usage per call, read from a copy of each response (never touches headers or keys).
type Usage = { label: string; model: string; input: number; cacheRead: number; cacheWrite: number; output: number };
const calls: Usage[] = [];
let label = "";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const res = await realFetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.anthropic.com/v1/messages") && res.ok) {
    let model = "";
    try { model = String(JSON.parse(String(init?.body ?? "{}")).model ?? ""); } catch {}
    const u: Usage = { label, model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const take = (x: Record<string, number> | undefined) => {
      if (!x) return;
      u.input = x.input_tokens ?? u.input;
      u.cacheRead = x.cache_read_input_tokens ?? u.cacheRead;
      u.cacheWrite = x.cache_creation_input_tokens ?? u.cacheWrite;
      u.output = x.output_tokens ?? u.output;
    };
    calls.push(u);
    void res.clone().text().then((body) => {
      if (body.trimStart().startsWith("{")) return take(JSON.parse(body).usage);
      for (const line of body.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const d = JSON.parse(line.slice(6));
          take(d.message?.usage);
          take(d.usage);
        } catch {}
      }
    }).catch(() => {});
  }
  return res;
};
/**
 * $ per million tokens. Claude Haiku 5.5: $0.10 in / $0.50 out, cache reads 0.1x, writes 1.25x, and 5x when a prompt
 * passes 100K tokens. Claude Sonnet 5.5: $2 in / $10 out, cache reads $0.10, writes 1.25x.
 */
const RATES = { haiku: { in: 0.1, out: 0.5, read: 0.01, write: 0.125 }, sonnet: { in: 2, out: 10, read: 0.1, write: 2.5 } };
const promptOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
const costOf = (u: Usage) => {
  const sonnet = u.model.includes("sonnet");
  const r = sonnet ? RATES.sonnet : RATES.haiku;
  const cliff = !sonnet && promptOf(u) > 100_000 ? 5 : 1;
  return ((u.input * r.in + u.cacheRead * r.read + u.cacheWrite * r.write + u.output * r.out) * cliff) / 1e6;
};
function usageOf(prefix: string) {
  const us = calls.filter((u) => u.label === prefix);
  return {
    calls: us.length,
    maxPrompt: Math.max(0, ...us.map(promptOf)),
    cacheRead: us.reduce((n, u) => n + u.cacheRead, 0),
    cacheWrite: us.reduce((n, u) => n + u.cacheWrite, 0),
    output: us.reduce((n, u) => n + u.output, 0),
    over100k: us.filter((u) => promptOf(u) > 100_000).length,
    cost: Number(us.reduce((n, u) => n + costOf(u), 0).toFixed(5)),
  };
}

fs.rmSync(path.join(dir, "pg"), { recursive: true, force: true });
const release = acquireLock(dir, "persona run");
const db = await openDb(dir);
const embedder = createEmbedder();
const memory = new MemoryQueue({ db, embedder });
await syncEmbeddings({ db, embedder }); // records the embedding model, so the app won't re-embed this folder
const user = await getOrCreateUser(db, undefined, TIMEZONE);
// Same file `npm run seed` writes: DATA_DIR=<dir> npm run dev, then /?seed=1 opens Riya's chats.
fs.writeFileSync(path.join(dir, "seed-user.json"), JSON.stringify({ userId: user.id, timezone: TIMEZONE, seededAt: new Date().toISOString() }, null, 2));
console.log(`set ${set} · main ${modelName("main")} · small ${modelName("small")} · embeddings ${modelName("embedding")} · user ${user.id}`);

type Row = {
  n: number;
  chat: number;
  kind: "history" | "test";
  at: string;
  text: string;
  expect?: Pick<Msg, "must" | "ok" | "avoid">;
  look?: string;
  plan?: AgentEvents["plan"];
  memory: Array<{ event: string; data: unknown }>;
  searches: string[];
  /** Each history tool call: past chats read, or saved web results read. */
  history: Array<{ what: "chats" | "web"; items: number }>;
  answer: string;
  error?: string;
  ms: { firstWord?: number; done?: number; memoryWriter?: number };
  memories: Array<{ kind: string; topic: string; text: string }>;
  usage?: { turn: ReturnType<typeof usageOf>; writer: ReturnType<typeof usageOf> };
};
const rows: Row[] = [];
const save = () => {
  for (const r of rows) r.usage = { turn: usageOf(`turn #${r.n}`), writer: usageOf(`writer #${r.n}`) };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(rows, null, 2));
};

async function send(base: Pick<Row, "n" | "chat" | "kind" | "text" | "expect" | "look">, sessionId: string | null, at?: DateTime): Promise<string | null> {
  const row: Row = { ...base, at: (at ?? DateTime.now().setZone(TIMEZONE)).toFormat("ccc d LLL HH:mm"), memory: [], searches: [], history: [], answer: "", ms: {}, memories: [] };
  let session = sessionId;
  let exchangeId = "";
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  label = `turn #${row.n}`;
  await runTurn({ db, embedder, memory }, { userId: user.id, timezone: TIMEZONE, sessionId, message: row.text, now: at?.toJSDate() }, (event, data) => {
    const d = data as never as Record<string, unknown>;
    if (event === "session") session = String(d.sessionId);
    else if (event === "plan") row.plan = data as AgentEvents["plan"];
    else if (event.startsWith("memory.")) row.memory.push({ event, data });
    else if (event === "web.search") row.searches.push(String(d.query));
    else if (event === "history.read") row.history.push({ what: d.what as "chats" | "web", items: (d.items as unknown[]).length });
    else if (event === "answer.token") {
      row.ms.firstWord ??= since();
      row.answer += String(d.text);
    } else if (event === "done") {
      row.ms.done = since();
      exchangeId = String(d.exchangeId);
    } else if (event === "error") row.error = `${d.step}: ${d.message}`;
  });
  label = `writer #${row.n}`;
  const tm = performance.now();
  await memory.idle(); // as if the user paused before the next message: the writer sees earlier memories
  row.ms.memoryWriter = Math.round(performance.now() - tm);
  if (exchangeId) {
    row.memories = (await db.query<{ kind: string; topic: string; text: string }>(`SELECT kind, topic, text FROM memories WHERE exchange_id = $1 ORDER BY text`, [exchangeId])).rows;
  }
  rows.push(row);
  save();
  const mem = row.memories.length ? row.memories.map((m) => `\n      + [${m.kind}] ${m.text}`).join("") : "\n      (no memory)";
  const reads = row.history.map((h) => `${h.what === "chats" ? "read chats" : "read saved results"} (${h.items})`).join(", ");
  console.log(`#${row.n} ${row.at} · ${(row.ms.done ?? 0) / 1000}s (first word ${(row.ms.firstWord ?? 0) / 1000}s) · ${row.searches.length} search(es)${reads ? ` · ${reads}` : ""} · writer ${row.ms.memoryWriter / 1000}s${row.error ? ` · ERROR ${row.error}` : ""}${mem}`);
  return session;
}

let n = 0;
for (const [i, chat] of chats.entries()) {
  let session: string | null = null;
  const start = DateTime.fromISO(chat.at, { zone: TIMEZONE });
  for (const [j, msg] of chat.messages.entries()) {
    const { text, ...expect } = msg;
    session = await send({ n: ++n, chat: i + 1, kind: "history", text, expect }, session, start.plus({ minutes: 3 * j }));
  }
}
// --tests-at=2026-11-21T17:20 asks the tests at a fixed time instead of now, so "this morning" or
// "last Tuesday" mean the same as in an earlier run and the two runs can be compared.
const testsAt = arg("tests-at");
for (const [i, test] of tests.entries()) {
  const at = testsAt ? DateTime.fromISO(testsAt, { zone: TIMEZONE }).plus({ minutes: 2 * i }) : undefined;
  const session = await send({ n: ++n, chat: chats.length + i + 1, kind: "test", text: test.text, look: test.look }, null, at);
  if (test.followUp) await send({ n: ++n, chat: chats.length + i + 1, kind: "test", text: test.followUp.text, look: test.followUp.look }, session, at?.plus({ minutes: 1 }));
}

await new Promise((r) => setTimeout(r, 2_000)); // let the last usage copies finish reading
save();
await db.close();
release();
const total = rows.reduce((s, r) => s + (r.usage?.turn.cost ?? 0) + (r.usage?.writer.cost ?? 0), 0);
console.log(`\nDone: ${rows.length} messages, about $${total.toFixed(2)} of Claude. Results in ${path.join(dir, "run.json")}`);
