import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import type { DB } from "../src/db";
import type { AgentEvents } from "../src/events";
import { randomUUID } from "node:crypto";
import { exRef, failStalePending, getOrCreateUser, startExchange } from "../src/exchangeStore";
import { toVector } from "../src/models";
import { memRef } from "../src/retriever";
import { MemoryQueue } from "../src/memoryWriter";
import { runTurn } from "../src/turn";
import { addSession, fakeEmbedder, testDb, TZ } from "./helpers";

/**
 * One whole turn through the real pipeline (store → planner → retriever → prompt → answerer →
 * store → memory queue) with the two models and Exa mocked. Checks the wiring: events, the tool
 * loop cap, quote verification, the sources footer and saved observations.
 */

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish" as const, finishReason: { unified, raw: undefined }, usage });
const toolCall = (id: string, query: string) => ({ type: "tool-call" as const, toolCallId: id, toolName: "web_search", input: JSON.stringify({ query, numResults: null, startPublishedDate: null }) });
const textChunks = (text: string) => [
  { type: "text-start" as const, id: "t" },
  ...text.match(/.{1,7}/gs)!.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
  { type: "text-end" as const, id: "t" },
];

const plan = { questions: [{ queryId: "q1", needsMemory: true, query: "Postgres hosting pricing", keywords: ["Postgres", "hosting", "pricing"], timePhrase: null, timeRefersTo: null, dateSide: "user", wantsCurrent: true, allMemories: false }] };
// One memory quotes the user's message; the other was taken from somewhere else and must be dropped.
const memories = {
  memories: [
    { kind: "preference", topic: "database hosting", entities: ["Neon"], text: "The user's app runs on Neon.", quote: "We moved our app to Neon last week" },
    { kind: "preference", topic: "database hosting", entities: ["Supabase"], text: "The user is considering Supabase Pro.", quote: "Supabase Pro is $25/month" },
  ],
};

// Small model: answers the Planner or the Memory Writer, depending on which system prompt it gets.
const small = new MockLanguageModelV3({
  doGenerate: async (opts) => {
    const system = JSON.stringify(opts.prompt[0]);
    const body = system.includes("Memory Extractor") ? memories : plan;
    return { content: [{ type: "text", text: JSON.stringify(body) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  },
});

let mainScript: (call: number) => unknown[] = () => [];
let mainCalls = 0;
const main = new MockLanguageModelV3({
  doStream: async () => ({ stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...mainScript(mainCalls++)] as never[] }) }),
});

vi.mock("../src/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/models")>()),
  model: (role: "main" | "small") => (role === "main" ? main : small),
  answerModel: () => main,
  providerOptions: () => ({}),
  memoryWriterOptions: () => ({}),
  cacheControl: () => undefined,
}));
vi.mock("../src/webSearch", () => ({
  webSearch: vi.fn(async (query: string) => {
    if (query.includes("fail")) throw new Error("timeout");
    return [{ title: "Neon Pricing", url: "https://neon.com/pricing", publishedDate: "2026-10-01", crawledAt: "2026-11-19", highlights: ["Launch $19/month"], text: "# Pricing\n## Plans\n| Plan | Price |\n|---|---|\n| Free | $0 |\n| Launch | $19/month |\n| Scale | $69/month |" }];
  }),
}));

let db: DB;
let userId: string;
let pastRef: string;
let pastMemory: string;

beforeAll(async () => {
  ({ db, userId } = await testDb());
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const { sessionId, exchangeIds } = await addSession(db, userId, [
    { user: "Which managed Postgres hosting is good for a small SaaS, and what does it cost?", assistant: "Neon Launch is $19/month and Supabase Pro is $25/month.", at: twoDaysAgo },
  ]);
  pastRef = exRef(exchangeIds[0]!);
  // What the Memory Writer would have saved for it, and the page that answer cited.
  const text = "The user asked which managed Postgres hosting is good for a small SaaS and what it costs.";
  const [vec] = await fakeEmbedder.embed([text], "document");
  const id = randomUUID();
  await db.query(
    `INSERT INTO memories (id, user_id, session_id, exchange_id, kind, speaker, topic, entities, text, hash, occurred_at, embedding, fts)
     VALUES ($1, $2, $3, $4, 'request', 'user', 'Postgres hosting', '{Postgres}', $5, $6, $7, $8::vector, to_tsvector('english', $5))`,
    [id, userId, sessionId, exchangeIds[0], text, "h1", twoDaysAgo, toVector(vec!)],
  );
  await db.query(
    `INSERT INTO observations (id, exchange_id, url, title, excerpt, observed_at, search_query) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), exchangeIds[0], "https://neon.com/pricing", "Neon Pricing", "| Launch | $19/month |", twoDaysAgo, "Neon pricing"],
  );
  pastMemory = memRef(id);
});

async function turn(message: string) {
  const events: Array<{ event: keyof AgentEvents; data: unknown }> = [];
  const memory = new MemoryQueue({ db, embedder: fakeEmbedder });
  await runTurn({ db, embedder: fakeEmbedder, memory }, { userId, timezone: TZ, sessionId: null, message }, (event, data) => events.push({ event, data }));
  await memory.idle();
  const done = events.find((e) => e.event === "done")?.data as AgentEvents["done"] | undefined;
  return { events, done, names: events.map((e) => e.event) };
}

describe("a full turn", () => {
  it("plans, finds the past session, searches, answers with verified quotes and citations, and stores it all", async () => {
    mainCalls = 0;
    mainScript = (call) =>
      call === 0
        ? [{ type: "tool-call" as const, toolCallId: "h1", toolName: "read_past_web_results", input: JSON.stringify({ ids: [pastMemory] }) }, toolCall("c1", "Neon pricing"), finish("tool-calls")]
        : [
            ...textChunks(`You asked <q ex="${pastRef}" side="user">which managed Postgres hosting is good</q>. Neon Launch is still $19/month [1]: **Unchanged**. I never said <q ex="${pastRef}" side="user">Supabase is free</q>.`),
            finish("stop"),
          ];
    const { names, events, done } = await turn("Has Neon's pricing changed since I asked? We moved our app to Neon last week.");

    expect(names).toEqual(expect.arrayContaining(["session", "plan", "memory.search", "memory.found", "history.read", "web.search", "web.result", "compare", "answer.token", "done"]));
    expect(names.indexOf("memory.found")).toBeLessThan(names.indexOf("web.search"));
    expect(names.at(-1)).toBe("done");

    // The first call saw the memory, not the past chat; the second also saw what the tools returned.
    const first = JSON.stringify(main.doStreamCalls[0]!.prompt);
    expect(first).toContain(`[${pastMemory} · `);
    expect(first).not.toContain("Neon Launch is $19/month and Supabase Pro"); // the past reply only arrives through a tool
    const prompt = JSON.stringify(main.doStreamCalls[1]!.prompt);
    expect(prompt).toContain("| Launch | $19/month |"); // the saved web result, word for word
    expect(prompt).toContain(`[I answered,`);
    expect(prompt).toContain("[1] Neon Pricing");

    const { rows } = await db.query<{ assistant_text: string; status: string }>(`SELECT assistant_text, status FROM exchanges WHERE id = $1`, [done!.exchangeId]);
    const stored = rows[0]!;
    expect(stored.status).toBe("complete");
    expect(stored.assistant_text).toMatch(new RegExp(`<q ex="${pastRef}" side="user" at="[^"]+">which managed Postgres hosting is good</q>`));
    expect(stored.assistant_text).toContain("I never said Supabase is free."); // unverified quote → plain text
    expect(stored.assistant_text).toContain("Sources:\n[1] Neon Pricing — https://neon.com/pricing");
    const streamed = events.filter((e) => e.event === "answer.token").map((e) => (e.data as { text: string }).text).join("");
    expect(streamed).toBe(stored.assistant_text);

    const obs = await db.query<{ url: string; excerpt: string; search_query: string }>(`SELECT url, excerpt, search_query FROM observations WHERE exchange_id = $1`, [done!.exchangeId]);
    expect(obs.rows).toHaveLength(1);
    expect(obs.rows[0]).toMatchObject({ url: "https://neon.com/pricing", search_query: "Neon pricing" });
    expect(obs.rows[0]!.excerpt).toContain("| Plan | Price |"); // table header kept with the matched row
    expect(obs.rows[0]!.excerpt).toContain("Launch | $19/month");

    const mem = await db.query<{ kind: string; speaker: string; text: string }>(`SELECT kind, speaker, text FROM memories WHERE exchange_id = $1`, [done!.exchangeId]);
    // Only the memory whose quote is in the user's message survives (the other quotes the assistant's old reply).
    expect(mem.rows).toEqual([{ kind: "preference", speaker: "user", text: "The user's app runs on Neon." }]);
  });

  it("stops at the backstop of MAX_TOOL_ROUNDS rounds, then forbids tools without undeclaring them", async () => {
    mainCalls = 0;
    main.doStreamCalls.length = 0;
    mainScript = (call) => (call < config.MAX_TOOL_ROUNDS ? [toolCall(`c${call}`, `query ${call}`), finish("tool-calls")] : [...textChunks("Here is what I found."), finish("stop")]);
    const { events } = await turn("Search a lot please");
    expect(events.filter((e) => e.event === "web.search")).toHaveLength(config.MAX_TOOL_ROUNDS);
    const last = main.doStreamCalls.at(-1)!;
    // Same tools as the earlier rounds (Claude rejects a changed tool list under earlier thinking blocks).
    expect(last.toolChoice).toEqual({ type: "none" });
    expect(last.tools?.map((t) => t.name)).toEqual(main.doStreamCalls[0]!.tools?.map((t) => t.name));
  });

  it("a failed search becomes a reported gap, not a failed turn", async () => {
    mainCalls = 0;
    mainScript = (call) => (call === 0 ? [toolCall("c1", "fail please"), finish("tool-calls")] : [...textChunks("I couldn't verify Zoho."), finish("stop")]);
    const { events, done } = await turn("Check Zoho pricing");
    const result = events.find((e) => e.event === "web.result")?.data as AgentEvents["web.result"];
    expect(result.error).toBe("timeout");
    expect(done).toBeDefined();
    expect(JSON.stringify(main.doStreamCalls.at(-1)!.prompt)).toContain("SEARCH FAILED");
  });

  it("text written before and after a search round become separate paragraphs", async () => {
    mainCalls = 0;
    mainScript = (call) =>
      call === 0 ? [...textChunks("Let me check."), toolCall("c1", "Neon pricing"), finish("tool-calls")] : [...textChunks("| Plan | Price |\n|---|---|\n| Launch | $19 [1] |"), finish("stop")];
    const { done } = await turn("Table please");
    const { rows } = await db.query<{ assistant_text: string }>(`SELECT assistant_text FROM exchanges WHERE id = $1`, [done!.exchangeId]);
    expect(rows[0]!.assistant_text).toMatch(/^Let me check\.\n\n\| Plan \| Price \|/);
  });

  it("bad ids from a cookie or request never reach a uuid column", async () => {
    const user = await getOrCreateUser(db, "not-a-uuid", TZ);
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    const { session, isNewSession } = await startExchange(db, { userId, sessionId: "garbage", text: "hi", sentAt: new Date() });
    expect(isNewSession).toBe(true);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("on startup, exchanges a dead process left pending are marked failed", async () => {
    const { exchange } = await startExchange(db, { userId, sessionId: null, text: "server died here", sentAt: new Date() });
    expect(await failStalePending(db)).toBeGreaterThanOrEqual(1);
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM exchanges WHERE id = $1`, [exchange.id]);
    expect(rows[0]!.status).toBe("failed");
  });

  it("if the answer fails, the user side is kept and the turn is marked failed", async () => {
    mainCalls = 0;
    mainScript = () => [{ type: "error", error: new Error("model overloaded") }];
    const { events } = await turn("This one will fail");
    const error = events.find((e) => e.event === "error")?.data as AgentEvents["error"];
    expect(error).toMatchObject({ step: "answer" });
    const { rows } = await db.query<{ status: string; assistant_text: string | null }>(`SELECT status, assistant_text FROM exchanges WHERE user_text = 'This one will fail'`);
    expect(rows).toEqual([{ status: "failed", assistant_text: null }]);
  });
});
