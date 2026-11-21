import { answer } from "./answerer";
import { buildPrompt } from "./promptBuilder";
import type { DB } from "./db";
import type { Emit } from "./events";
import { completeExchange, exRef, failExchange, sessionExchanges, startExchange } from "./exchangeStore";
import { turnLogger } from "./log";
import type { MemoryQueue } from "./memoryWriter";
import type { Embedder } from "./models";
import { plan } from "./planner";
import { retrieve, scopeLabel, type RetrievalResult } from "./retriever";

/**
 * One user message, end to end. Read this file top to bottom to trace a turn:
 *   1 store user side → 2 plan → 3 retrieve → 4 build the prompt → 5 answer (streamed) → 6 store reply → 7 queue memories
 * The Answerer reads the memories retrieval finds for this message, and fetches the chats behind them when it needs to.
 */
export type TurnDeps = { db: DB; embedder: Embedder; memory: MemoryQueue };
export type TurnInput = {
  userId: string;
  timezone: string;
  sessionId: string | null;
  message: string;
  /** When the message was sent. Scripts set it to replay a dated history; the server never does. */
  now?: Date;
};

export async function runTurn(deps: TurnDeps, input: TurnInput, emit: Emit): Promise<void> {
  const { db } = deps;
  const offset = input.now ? input.now.getTime() - Date.now() : 0;
  const clock = () => new Date(Date.now() + offset);
  const now = clock();

  // 1. Exchange Store: the user side is saved before anything else can fail.
  let started: Awaited<ReturnType<typeof startExchange>>;
  try {
    started = await startExchange(db, { userId: input.userId, sessionId: input.sessionId, text: input.message, sentAt: now });
  } catch (err) {
    console.error("[turn] could not store the message:", err);
    return emit("error", { message: (err as Error).message || String(err), step: "store" });
  }
  const { exchange, session, isNewSession } = started;
  emit("session", { sessionId: session.id, title: session.title, isNew: isNewSession });
  const log = turnLogger(exRef(exchange.id));

  let step = "plan";
  try {
    // 2. Planner: split into questions; decide memory / web needs; resolve time phrases in code.
    const currentChat = isNewSession ? [] : (await sessionExchanges(db, session.id, { completeOnly: true })).filter((e) => e.id !== exchange.id);
    const planned = await log.time("planner", () => plan({ message: input.message, recent: currentChat, timezone: input.timezone, now }), (p) =>
      `${p.questions.length} question(s)${p.fallback ? " (fallback plan)" : ""}: ${p.questions.map((q) => `${q.queryId}[mem=${q.needsMemory} ${q.window.mode} ${q.dateSide}${q.dateOnly ? " date-only" : ""}] "${q.query}"`).join("; ")}`,
    );
    emit("plan", { needsWeb: planned.plan.needsWeb, questions: planned.questions.map((q) => ({ queryId: q.queryId, summary: q.query, needsMemory: q.needsMemory })) });

    // 3. Retriever: deterministic hybrid search over past sessions (the current one is excluded).
    step = "memory";
    const memoryQuestions = planned.questions.filter((q) => q.needsMemory);
    for (const q of memoryQuestions) emit("memory.search", { queryId: q.queryId, searched: scopeLabel(q, input.timezone, now) });
    const results: RetrievalResult[] = memoryQuestions.length
      ? await log.time("retriever", () => retrieve(deps, { userId: input.userId, currentSessionId: session.id, timezone: input.timezone, now, questions: planned.questions }), (rs) =>
          rs.map((r) => `${r.queryId}:${r.status}(${r.sessions.length} chats, ${r.memories.length} memories)`).join(" "),
        )
      : [];
    for (const r of results) emitRetrieval(emit, r);

    // 4. Prompt: the current chat in full + the matching memories; past chats only on request.
    const prompt = buildPrompt({ message: input.message, timezone: input.timezone, now, needsWeb: planned.plan.needsWeb, questions: planned.questions, results, currentChat });
    log.info(`prompt     memories=${prompt.stats.memories} chat≈${prompt.stats.chatTokens}t`);

    // 5. Answerer: reasons, reads past chats or saved web results if it needs them, searches the web, streams.
    step = "answer";
    const pastDates = [...new Set(results.flatMap((r) => r.sessions.map((s) => s.date)))];
    const reply = await log.time("answerer", () => answer({ db, prompt, timezone: input.timezone, now, pastDates, emit }), (a) => `${a.searches} search(es), ${a.observations.length} observation(s)`);

    // 6. Exchange Store: reply + observations, embedded now so the next message can find it.
    step = "save";
    await log.time("store", () => completeExchange(deps, { exchangeId: exchange.id, userText: input.message, assistantText: reply.text, sentAt: clock(), observations: reply.observations }));
    emit("done", { exchangeId: exchange.id, sessionId: session.id });
    log.total();

    // 7. Background: the Memory Writer gets the exchange and what was retrieved for it.
    deps.memory.enqueue({ exchangeId: exchange.id, relatedExchangeIds: results.flatMap((r) => r.sessions.flatMap((s) => s.matches.map((m) => m.exchangeId))) });
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(`[turn ${exRef(exchange.id)}] failed at ${step}:`, err);
    await failExchange(db, exchange.id);
    emit("error", { message, step });
  }
}

function emitRetrieval(emit: Emit, r: RetrievalResult) {
  if (r.status === "found") emit("memory.found", { queryId: r.queryId, memories: r.memories.length, sessions: r.sessions.map((s) => ({ title: s.title, date: s.date })), all: r.all });
  else if (r.status === "none_on_date") emit("memory.none_on_date", { queryId: r.queryId, date: r.searched, nearestElsewhere: r.nearestElsewhere && { title: r.nearestElsewhere.title, date: r.nearestElsewhere.date } });
  else emit("memory.none", { queryId: r.queryId, searched: r.searched });
}
