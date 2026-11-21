import { describe, expect, it } from "vitest";
import { exRef, type Exchange, type Observation, type Transcript } from "../src/exchangeStore";
import { buildPrompt, renderSession, renderWebResults } from "../src/promptBuilder";
import type { RetrievalResult, RetrievedMemory } from "../src/retriever";
import { NOW, TZ, at, question } from "./helpers";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const exchange = (n: number, user: string, assistant: string, when: Date, session = 1): Exchange => ({
  id: uuid(n), sessionId: uuid(session), userId: uuid(0), seq: n, userText: user, userSentAt: when,
  assistantText: assistant, assistantSentAt: new Date(when.getTime() + 60_000), status: "complete",
});
const memory = (n: number, ex: Exchange, kind: RetrievedMemory["kind"], text: string, extra: Partial<RetrievedMemory> = {}): RetrievedMemory => ({
  ref: `m_${String(n).padStart(8, "0")}`, id: uuid(500 + n), exchangeId: ex.id, sessionId: ex.sessionId, kind, text, at: ex.userSentAt,
  matched: true, otherDay: false, hasWeb: false, ...extra,
});
const found = (memories: RetrievedMemory[], extra: Partial<RetrievalResult> = {}): RetrievalResult => ({
  queryId: "q1", status: "found", searched: "all history", memories,
  sessions: [{ sessionId: uuid(1), title: "CRM", date: "Mon 16 Nov", score: 1, matches: memories.map((m) => ({ exchangeId: m.exchangeId, matchedSide: "both" as const, at: m.at })) }],
  ...extra,
});
const base = { message: "What's on our CRM shortlist now?", timezone: TZ, now: NOW, needsWeb: false, currentChat: [] as Exchange[] };

const monday = exchange(1, "We'll shortlist these 5: HubSpot, Pipedrive, Close, Zoho and Freshsales", "SECRET-REPLY-MONDAY Great, five CRMs.", at("2026-11-16T14:05"));
const wednesday = exchange(2, "Drop Close and add Salesforce Starter", "SECRET-REPLY-WEDNESDAY Done.", at("2026-11-18T11:00"));
const mMon = memory(1, monday, "decision", "On Mon 16 Nov 2026 the user shortlisted HubSpot, Pipedrive, Close, Zoho and Freshsales.", { hasWeb: true });
const mWed = memory(2, wednesday, "decision", "On Wed 18 Nov 2026 the user replaced Close with Salesforce Starter.");

describe("buildPrompt", () => {
  it("gives the matching memories, oldest first and labelled, and no past transcripts", () => {
    const p = buildPrompt({ ...base, questions: [question({ query: "CRM shortlist" })], results: [found([mWed, mMon])] });
    const text = p.finalUserMessage;
    expect(text).toContain("<memories>");
    expect(text.indexOf(mMon.text)).toBeLessThan(text.indexOf(mWed.text)); // date order, whatever the ranking
    expect(text).toContain(`[${mMon.ref} · Mon 16 Nov 14:05 · decision · web] ${mMon.text}`);
    expect(text).not.toContain("SECRET-REPLY"); // the assistant's past words never come in by default
    expect(p.stats.memories).toBe(2);
  });

  it("lets the tools resolve every memory id, and names matched messages that have no memory", () => {
    const bare = exchange(3, "Hmm, let me think", "Sure.", at("2026-11-14T10:03"));
    const r = found([mMon]);
    r.sessions[0]!.matches.push({ exchangeId: bare.id, matchedSide: "both", at: bare.userSentAt });
    const p = buildPrompt({ ...base, questions: [question({ query: "CRM shortlist" })], results: [r] });
    expect(p.pointers.get(mMon.ref)).toEqual({ exchangeId: monday.id, sessionId: monday.sessionId, hasWeb: true });
    expect(p.pointers.has(exRef(bare.id))).toBe(true);
    expect(p.finalUserMessage).toContain(`Matching messages with no memory saved (read them with read_past_chats): ${exRef(bare.id)}`);
  });

  it("notes name the memory ids per question; date questions say only these count", () => {
    const clip = { start: at("2026-11-18T00:00"), end: at("2026-11-18T23:59:59.999"), side: "user" as const };
    const q = question({ query: "CRM change", timePhrase: "on Wednesday", dateSide: "user" });
    const p = buildPrompt({ ...base, questions: [q], results: [found([mWed], { clip })] });
    expect(p.finalUserMessage).toContain(`1 memory from 1 chat (Mon 16 Nov): ${mWed.ref}`);
    expect(p.finalUserMessage).toContain("Only these are from the time asked about.");
  });

  it("nothing on the date: offers the nearest chat's memories, marked as another day", () => {
    const near = memory(3, monday, "request", "On Mon 16 Nov 2026 the user asked for 5 CRM options.", { matched: false, otherDay: true });
    const r: RetrievalResult = { queryId: "q1", status: "none_on_date", searched: "Sun 15 Nov only", sessions: [], memories: [near], nearestElsewhere: { sessionId: monday.sessionId, title: "CRM", date: "Mon 16 Nov" } };
    const p = buildPrompt({ ...base, questions: [question({ query: "what we discussed", timePhrase: "on Sunday" })], results: [r] });
    expect(p.finalUserMessage).toContain("· request · another day]");
    expect(p.finalUserMessage).toContain('Nearest chat on another day: Mon 16 Nov, "CRM"');
  });

  it("puts the current chat in whole, as chat turns, and makes it quotable", () => {
    const long = exchange(4, "compare CRMs", `table ${"x".repeat(9_000)} end-of-table`, at("2026-11-19T13:00"), 9);
    const p = buildPrompt({ ...base, currentChat: [long], questions: [], results: [] });
    expect(p.chat).toHaveLength(2);
    expect(String(p.chat[1]!.content)).toContain("end-of-table");
    expect(p.quoteIndex.get(exRef(long.id))?.user).toBe("compare CRMs");
    expect(p.finalUserMessage).not.toContain("<memories>");
  });
});

describe("tool results", () => {
  it("a past chat comes back with every line labelled", () => {
    const t: Transcript = { session: { id: uuid(1), userId: uuid(0), title: "CRM", startedAt: monday.userSentAt }, exchanges: [monday, wednesday], observations: new Map() };
    const text = renderSession(t, TZ, NOW);
    expect(text).toContain(`[${exRef(monday.id)} · User · Mon 16 Nov 14:05] We'll shortlist these 5`);
    expect(text).toContain(`[${exRef(wednesday.id)} · Assistant · Wed 18 Nov 11:01] SECRET-REPLY-WEDNESDAY`);
  });

  it("saved web results come back word for word, with where and when they were read", () => {
    const o: Observation = { id: uuid(900), exchangeId: monday.id, url: "https://www.pipedrive.com/pricing", title: "Pipedrive pricing", excerpt: "| Growth | $39 per seat |", observedAt: monday.assistantSentAt!, searchQuery: "Pipedrive pricing" };
    const text = renderWebResults(monday, [o], TZ, NOW);
    expect(text).toContain("[I answered, Mon 16 Nov 14:06] SECRET-REPLY-MONDAY");
    expect(text).toContain('Pipedrive pricing · https://www.pipedrive.com/pricing @ Mon 16 Nov 14:06 (search: "Pipedrive pricing")');
    expect(text).toContain("| Growth | $39 per seat |");
    expect(renderWebResults(wednesday, [], TZ, NOW)).toContain("No web results were saved for this answer.");
  });
});
