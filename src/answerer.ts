import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { config } from "./config";
import type { DB } from "./db";
import type { Emit } from "./events";
import { loadTranscripts, observationsFor, toExchange, type NewObservation } from "./exchangeStore";
import { answerModel, cacheControl, modelName, providerOptions } from "./models";
import { claimsCiting, selectExcerpt } from "./observations";
import { indexQuote, renderSession, renderWebResults, type AnswerPrompt, type Pointer } from "./promptBuilder";
import { ANSWERER_SYSTEM } from "./prompts/answerer";
import { createQuoteVerifier } from "./quoteVerifier";
import { dayLabel } from "./time";
import { webSearch, type WebResult } from "./webSearch";

/**
 * Answerer: MAIN_MODEL with three tools: web_search, and two that read the past on demand
 * (read_past_chats, read_past_web_results). Up to MAX_TOOL_ROUNDS rounds of (parallel) tool calls,
 * then it must answer. Text streams through the quote verifier; a numbered sources list is
 * appended by code (so URLs are never mistyped), and the cited sources become observations.
 */

export type AnswerResult = { text: string; observations: NewObservation[]; searches: number };

export async function answer(input: {
  db: DB;
  prompt: AnswerPrompt;
  timezone: string;
  now: Date;
  pastDates: string[];
  emit: Emit;
  signal?: AbortSignal;
}): Promise<AnswerResult> {
  const { prompt, emit } = input;
  const sources = new SourceRegistry(config.WEB_CONTEXT_CHARS);

  // The current chat first (append-only, so it can be cached), then this turn's memories and message.
  const messages: ModelMessage[] = [...withCacheMarker(prompt.chat), { role: "user", content: prompt.finalUserMessage }];

  let fellBack = false;
  const onFallback = (reason: string) => {
    console.warn(`[answerer] ${modelName("main")} failed (${reason}); using ${modelName("fallback")}`);
    if (!fellBack) emit("model.fallback", { from: modelName("main"), to: modelName("fallback"), reason });
    fellBack = true;
  };

  const result = streamText({
    model: answerModel(onFallback),
    system: { role: "system", content: ANSWERER_SYSTEM, providerOptions: cacheControl("main") },
    messages,
    tools: { web_search: webSearchTool(sources, emit), ...historyTools(input) },
    stopWhen: stepCountIs(config.MAX_TOOL_ROUNDS + 1),
    // After the last tool round, forbid tools: the model has to answer with what it has. The tools
    // stay declared, because Claude rejects a request whose tools changed under earlier thinking blocks.
    prepareStep: ({ stepNumber }) => (stepNumber >= config.MAX_TOOL_ROUNDS ? { toolChoice: "none" as const } : {}),
    providerOptions: providerOptions("main"),
    abortSignal: input.signal,
  });

  const verifier = createQuoteVerifier((ref) => prompt.quoteIndex.get(ref));
  let text = "";
  let compared = false;
  const send = (chunk: string) => {
    if (!chunk) return;
    text += chunk;
    emit("answer.token", { text: chunk });
  };

  let newStep = false;
  for await (const part of result.fullStream) {
    if (part.type === "start-step") {
      newStep = true;
    } else if (part.type === "text-delta") {
      if (!compared && sources.size && input.pastDates.length) {
        compared = true;
        emit("compare", { summary: `Comparing what was said on ${input.pastDates.join(", ")} with ${sources.size} sources from today` });
      }
      // Text written before a tool round and text after it are separate paragraphs.
      if (newStep && text.trim()) send(verifier.push("\n\n"));
      newStep = false;
      send(verifier.push(part.text));
    } else if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }
  send(verifier.flush());
  if (!text.trim()) throw new Error("The model returned an empty answer.");

  const cited = sources.cited(text);
  if (cited.length) send(`\n\nSources:\n${cited.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n")}`);

  const observations = cited.map((s) => ({
    url: s.url,
    title: s.title,
    excerpt: selectExcerpt(s.text, s.highlights, claimsCiting(text, s.n), config.OBSERVATION_EXCERPT_CHARS),
    observedAt: input.now,
    searchQuery: s.query,
  }));
  return { text, observations, searches: sources.searches };
}

/** Cache marker on the last message of the current chat: the next message of this chat reads it from cache. */
function withCacheMarker(chat: ModelMessage[]): ModelMessage[] {
  const cache = cacheControl("main");
  const last = chat.at(-1);
  if (!cache || !last || last.role !== "assistant" || typeof last.content !== "string") return chat;
  return [...chat.slice(0, -1), { role: "assistant", content: [{ type: "text", text: last.content, providerOptions: cache }] }];
}

// ── History tools ──────────────────────────────────────────────────────────

/**
 * The past, on demand. Both take only the memory ids shown in <memories>, and open only the messages
 * and chats those memories came from, so the model can't wander into other chats or other users'
 * data. Every exchange they return becomes quotable.
 */
function historyTools(input: { db: DB; prompt: AnswerPrompt; timezone: string; now: Date; emit: Emit }) {
  const { db, prompt, timezone: tz, now, emit } = input;
  const ids = z.object({ ids: z.array(z.string()).describe('Ids from <memories>, like "m_1a2b3c4d". Several at once.') });
  const resolve = (list: string[]) => {
    const found: Pointer[] = [];
    const unknown: string[] = [];
    for (const id of list) {
      const p = prompt.pointers.get(id.trim());
      if (p) found.push(p);
      else unknown.push(id);
    }
    const note = unknown.length ? `Unknown id(s): ${unknown.join(", ")}. Use the ids shown in <memories>.\n\n` : "";
    return { found, note };
  };

  return {
    read_past_chats: tool({
      description:
        "Read the full transcripts of the past chats that memories came from: every message, mine and the user's, with its time. Use it when you need what was actually said: my answers and recommendations, the user's exact words, details a memory doesn't hold.",
      inputSchema: ids,
      execute: async ({ ids: list }) => {
        const { found, note } = resolve(list);
        const sessionIds = [...new Set(found.map((p) => p.sessionId))].slice(0, config.MAX_CHATS_PER_READ);
        if (!sessionIds.length) return `${note}Nothing to read.`;
        const transcripts = [...(await loadTranscripts(db, sessionIds)).values()].filter((t) => t.exchanges.length)
          .sort((a, b) => a.exchanges[0]!.userSentAt.getTime() - b.exchanges[0]!.userSentAt.getTime());
        for (const t of transcripts) for (const e of t.exchanges) indexQuote(prompt.quoteIndex, e, tz, now);
        emit("history.read", { what: "chats", items: transcripts.map((t) => ({ title: t.session.title, date: dayLabel(t.exchanges[0]!.userSentAt, tz, now) })) });
        const more = new Set(found.map((p) => p.sessionId)).size > sessionIds.length ? `\n\n(Only the first ${config.MAX_CHATS_PER_READ} chats; ask again for the rest.)` : "";
        return note + transcripts.map((t) => renderSession(t, tz, now)).join("\n\n") + more;
      },
    }),
    read_past_web_results: tool({
      description:
        'Read the web results I saved when I answered in a past chat: my answer, and the passages it cited, word for word, with the page address, when I read it and the search that found it. Pass memories marked "web". Use it for "has it changed since?", "is your answer still correct?" or "what did you find last time?".',
      inputSchema: ids,
      execute: async ({ ids: list }) => {
        const { found, note } = resolve(list);
        const exchangeIds = [...new Set(found.map((p) => p.exchangeId))];
        if (!exchangeIds.length) return `${note}Nothing to read.`;
        const { rows } = await db.query(`SELECT * FROM exchanges WHERE id = ANY($1::uuid[]) AND status = 'complete' ORDER BY user_sent_at, id`, [exchangeIds]);
        const exchanges = rows.map((r) => toExchange(r as never));
        const saved = await observationsFor(db, exchanges.map((e) => e.id));
        for (const e of exchanges) indexQuote(prompt.quoteIndex, e, tz, now);
        emit("history.read", { what: "web", items: exchanges.map((e) => ({ title: e.userText.slice(0, 60), date: dayLabel(e.userSentAt, tz, now) })) });
        return note + exchanges.map((e) => renderWebResults(e, saved.get(e.id) ?? [], tz, now)).join("\n\n");
      },
    }),
  };
}

// ── Web search ─────────────────────────────────────────────────────────────

function webSearchTool(sources: SourceRegistry, emit: Emit) {
  return tool({
    description:
      "Search the web. Returns numbered results with page text; cite them by number. Make several calls in parallel for independent items (e.g. one per vendor).",
    inputSchema: z.object({
      query: z.string().describe("Specific query, e.g. 'HubSpot Sales Hub pricing per seat' or 'Neon Postgres pricing'"),
      numResults: z.number().nullable().describe(`Results to return, 1-${config.WEB_MAX_RESULTS}. null = ${config.WEB_DEFAULT_RESULTS}.`),
      startPublishedDate: z
        .string()
        .nullable()
        .describe("ISO date (YYYY-MM-DD). ONLY for news-style queries (launches, announcements since a date). null for pricing or docs pages."),
    }),
    execute: async ({ query, numResults, startPublishedDate }, { abortSignal }) => {
      emit("web.search", { query });
      sources.searches++;
      const n = Math.min(config.WEB_MAX_RESULTS, Math.max(1, Math.round(numResults ?? config.WEB_DEFAULT_RESULTS)));
      try {
        const results = await webSearch(query, { numResults: n, startPublishedDate, signal: abortSignal });
        const numbered = results.map((r) => sources.add(r, query));
        emit("web.result", { query, sources: numbered.map((s) => ({ n: s.n, title: s.title, url: s.url })) });
        return numbered.length ? sources.format(numbered) : `No results for "${query}". Try a different query, or report this item as unverified.`;
      } catch (err) {
        const message = (err as Error).message || String(err);
        console.warn(`[web] "${query}" failed: ${message}`);
        emit("web.result", { query, sources: [], error: message });
        return `SEARCH FAILED for "${query}" (${message}). Tell the user you couldn't verify this item; don't guess.`;
      }
    },
  });
}

type Source = WebResult & { n: number; query: string; shown: boolean };

/** Numbers every distinct URL once per turn and keeps web text within its allowance (WEB_CONTEXT_CHARS). */
class SourceRegistry {
  private byUrl = new Map<string, Source>();
  searches = 0;
  constructor(private remainingChars: number) {}

  get size() {
    return this.byUrl.size;
  }

  add(r: WebResult, query: string): Source {
    const existing = this.byUrl.get(r.url);
    if (existing) return existing;
    const s: Source = { ...r, n: this.byUrl.size + 1, query, shown: false };
    this.byUrl.set(r.url, s);
    return s;
  }

  format(list: Source[]): string {
    const fresh = list.filter((s) => !s.shown);
    const perResult = Math.min(config.WEB_RESULT_PROMPT_CHARS, Math.floor(this.remainingChars / Math.max(1, fresh.length)));
    return list
      .map((s) => {
        const head = `[${s.n}] ${s.title}\nURL: ${s.url}${s.publishedDate ? `\nPublished: ${s.publishedDate.slice(0, 10)}` : ""}${s.crawledAt ? `\nFetched: ${s.crawledAt.slice(0, 10)}` : ""}`;
        if (s.shown) return `${head}\n(already shown above)`;
        s.shown = true;
        if (perResult < 200) return `${head}\n(web context budget used up; text not shown)`;
        const highlights = s.highlights.length ? `Highlights:\n${s.highlights.map((h) => `- ${h.trim()}`).join("\n")}\n` : "";
        const body = `${highlights}Text:\n${s.text}`.slice(0, perResult);
        this.remainingChars -= body.length;
        return `${head}\n${body}`;
      })
      .join("\n\n---\n\n");
  }

  /** Sources whose [n] marker appears in the final answer, in number order. */
  cited(answerText: string): Source[] {
    const ns = new Set([...answerText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return [...this.byUrl.values()].filter((s) => ns.has(s.n)).sort((a, b) => a.n - b.n);
  }
}
