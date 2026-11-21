import type { ModelMessage } from "ai";
import { config } from "./config";
import { exRef, type Exchange, type Observation, type Transcript } from "./exchangeStore";
import type { ResolvedQuestion } from "./planner";
import type { RetrievalResult, RetrievedMemory } from "./retriever";
import { dayTimeLabel, local } from "./time";

/**
 * Prompt builder: the Answerer's prompt is
 *   [static system prompt] → the current chat, in full → one user turn with
 *   <memories> (what the user said in earlier chats that matches this message, oldest first),
 *   <turn_context> (now, one note per question) and the message.
 * Past transcripts and saved web results are not in the prompt: the Answerer reads them with its
 * tools when it needs them, and the renderers for those tool results live here too.
 */

export type QuoteSource = { user: string; assistant: string; userAt: string; assistantAt: string };

/** What the history tools can resolve: a memory ref ("m_…"), to the message and chat it came from. */
export type Pointer = { exchangeId: string; sessionId: string; hasWeb: boolean };

export type AnswerPrompt = {
  /** The current chat as real chat turns (user lines carry their exchange id + time). */
  chat: ModelMessage[];
  /** Final user turn: memories, now, one note per question, then the user's message. */
  finalUserMessage: string;
  /** Every id the Answerer may pass to its history tools. */
  pointers: Map<string, Pointer>;
  /** Every exchange the model has seen, by "ex_…" ref: what the quote verifier checks against. The history tools add to it. */
  quoteIndex: Map<string, QuoteSource>;
  stats: { memories: number; chatTokens: number };
};

export type PromptInput = {
  message: string;
  timezone: string;
  now: Date;
  needsWeb: boolean;
  questions: ResolvedQuestion[];
  results: RetrievalResult[];
  currentChat: Exchange[];
};

export const tokens = (s: string) => Math.ceil(s.length / config.CHARS_PER_TOKEN);

export function buildPrompt(input: PromptInput): AnswerPrompt {
  const quoteIndex = new Map<string, QuoteSource>();
  const chat = packCurrentChat(input, quoteIndex);

  const memories = new Map<string, RetrievedMemory>();
  for (const r of input.results) for (const m of r.memories) if (!memories.has(m.ref)) memories.set(m.ref, m);
  const list = [...memories.values()].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));

  // Only memories open chats: a matched message with no memory hands over nothing.
  const pointers = new Map<string, Pointer>();
  for (const m of list) pointers.set(m.ref, { exchangeId: m.exchangeId, sessionId: m.sessionId, hasWeb: m.hasWeb });

  const finalUserMessage = [
    list.length ? memoriesBlock(list, input) : null,
    "<turn_context>",
    `Now: ${local(input.now, input.timezone).toFormat("cccc d LLLL yyyy, HH:mm")} (${input.timezone})`,
    "History lookup for this message:",
    ...input.questions.map((q) => `- ${statusLine(q, input.results.find((r) => r.queryId === q.queryId), input)}`),
    `Planner's guess: web search ${input.needsWeb ? "needed" : "probably not needed"}.`,
    "</turn_context>",
    "",
    input.message,
  ].filter((l) => l !== null).join("\n");

  return { chat: chat.messages, finalUserMessage, pointers, quoteIndex, stats: { memories: list.length, chatTokens: chat.tokens } };
}

function memoriesBlock(list: RetrievedMemory[], input: PromptInput): string {
  const lines = list.map((m) => {
    const tags = [m.kind, m.hasWeb ? "web" : null, m.otherDay ? "another day" : null].filter(Boolean).join(" · ");
    return `[${m.ref} · ${dayTimeLabel(m.at, input.timezone, input.now)} · ${tags}] ${m.text}`;
  });
  return `<memories>\n${lines.join("\n")}\n</memories>\n`;
}

// ── Current chat ───────────────────────────────────────────────────────────

/** The whole current chat, as real chat turns. */
function packCurrentChat(input: PromptInput, quoteIndex: Map<string, QuoteSource>) {
  const messages: ModelMessage[] = [];
  let used = 0;
  for (const e of input.currentChat) {
    indexQuote(quoteIndex, e, input.timezone, input.now);
    const user = `[${exRef(e.id)} · ${dayTimeLabel(e.userSentAt, input.timezone, input.now)}] ${cut(e.userText)}`;
    const assistant = cut(e.assistantText ?? "");
    messages.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    used += tokens(user) + tokens(assistant);
  }
  return { messages, tokens: used };
}

// ── Notes per question ─────────────────────────────────────────────────────

function statusLine(q: ResolvedQuestion, r: RetrievalResult | undefined, input: PromptInput): string {
  const head = `${q.queryId} (${q.query})`;
  if (!q.needsMemory || !r) return `${head}: no history lookup needed; use this chat and the web.`;
  if (r.all) return `${head}: a broad question, so <memories> holds every memory from all earlier chats (${r.memories.length}), unfiltered.`;
  if (r.status === "found") {
    // Only chats that contributed memories count: matches without a memory hand over nothing.
    const mine = r.memories.filter((m) => !m.otherDay);
    if (!mine.length) return `${head}: no matching memories (searched ${r.searched}).`;
    const chats = new Set(mine.map((m) => m.sessionId));
    const days = [...new Set(r.sessions.filter((s) => chats.has(s.sessionId)).map((s) => s.date))].join(", ");
    const onlyThese = r.clip ? " Only these are from the time asked about." : "";
    return `${head}: ${mine.length} memor${mine.length === 1 ? "y" : "ies"} from ${chats.size} chat${chats.size === 1 ? "" : "s"} (${days}): ${mine.map((m) => m.ref).join(", ")}. Searched: ${r.searched}.${onlyThese}`;
  }
  if (r.status === "none_on_date") {
    const near = r.nearestElsewhere
      ? ` Nearest chat on another day: ${r.nearestElsewhere.date}, "${r.nearestElsewhere.title}" (its memories are marked "another day"). That is NOT the conversation asked about; ask whether it's the one.`
      : " No matching chat on any other date either.";
    return `${head}: nothing found (searched ${r.searched}).${near}`;
  }
  return `${head}: no matching memories (searched ${r.searched}).`;
}

// ── Tool results ───────────────────────────────────────────────────────────

/** One past chat, every exchange, each line labelled: what read_past_chats returns. */
export function renderSession(t: Transcript, tz: string, now: Date): string {
  const lines = [`── Chat "${t.session.title}" (${local(t.exchanges[0]!.userSentAt, tz).toFormat("ccc d LLL yyyy")}) · ${t.exchanges.length} exchanges ──`];
  for (const e of t.exchanges) {
    lines.push(`[${exRef(e.id)} · User · ${dayTimeLabel(e.userSentAt, tz, now)}] ${cut(e.userText)}`);
    lines.push(`[${exRef(e.id)} · Assistant · ${dayTimeLabel(e.assistantSentAt!, tz, now)}] ${cut(e.assistantText ?? "")}`);
  }
  return lines.join("\n");
}

/** One past answer with the web results it cited, word for word: what read_past_web_results returns. */
export function renderWebResults(e: Exchange, observations: Observation[], tz: string, now: Date): string {
  const lines = [
    `── ${exRef(e.id)} · ${dayTimeLabel(e.userSentAt, tz, now)} ──`,
    `[User] ${cut(e.userText)}`,
    `[I answered, ${dayTimeLabel(e.assistantSentAt!, tz, now)}] ${cut(e.assistantText ?? "")}`,
    observations.length ? "Saved web results (the passages that answer cited, as they read then):" : "No web results were saved for this answer.",
  ];
  for (const o of observations) {
    const excerpt = o.excerpt.trim().split("\n").map((l) => `      ${l}`).join("\n");
    lines.push(`    observed: ${o.title} · ${o.url} @ ${dayTimeLabel(o.observedAt, tz, now)} (search: "${o.searchQuery}") →\n${excerpt}`);
  }
  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function indexQuote(index: Map<string, QuoteSource>, e: Exchange, tz: string, now: Date) {
  index.set(exRef(e.id), {
    user: e.userText,
    assistant: e.assistantText ?? "",
    userAt: dayTimeLabel(e.userSentAt, tz, now),
    assistantAt: e.assistantSentAt ? dayTimeLabel(e.assistantSentAt, tz, now) : "",
  });
}

function cut(text: string): string {
  if (text.length <= config.MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, config.MAX_MESSAGE_CHARS)} […${text.length - config.MAX_MESSAGE_CHARS} characters omitted…]`;
}
