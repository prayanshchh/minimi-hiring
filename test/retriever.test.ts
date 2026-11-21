import { beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db";
import { randomUUID } from "node:crypto";
import { toVector } from "../src/models";
import { retrieve } from "../src/retriever";
import { NOW, TZ, addSession, at, fakeEmbedder, question, testDb } from "./helpers";

let db: DB;
let userId: string;
const S: Record<string, { sessionId: string; exchangeIds: string[] }> = {};
const run = (qs: ReturnType<typeof question>[], currentSessionId: string | null = null) =>
  retrieve({ db, embedder: fakeEmbedder }, { userId, currentSessionId, timezone: TZ, now: NOW, questions: qs });

beforeAll(async () => {
  ({ db, userId } = await testDb());
  S.postgresOld = await addSession(db, userId, [
    { user: "Which Postgres hosting should I use? Compare Neon, Supabase and RDS pricing", assistant: "Neon Launch is $19/month, Supabase Pro $25/month, RDS from $15/month.", at: at("2026-11-10T15:00") },
  ]);
  // Asked at 23:59 Monday, answered at 00:01 Tuesday (user's local time).
  S.midnight = await addSession(db, userId, [
    { user: "How do I tune pgbouncer pool size?", assistant: "Start with pool size = 2 × cores and measure.", at: at("2026-11-16T23:59"), repliedAt: at("2026-11-17T00:01") },
  ]);
  S.crmMonday = await addSession(db, userId, [
    { user: "Shortlist 5 CRM tools for our 20-person sales team", assistant: "HubSpot, Pipedrive, Close, Zoho CRM, Freshsales. CRM shortlist pricing per seat: ...", at: at("2026-11-16T14:00") },
    { user: "Which CRM would you drop from the shortlist?", assistant: "I'd drop Freshsales from the CRM shortlist: forecasting needs a higher tier.", at: at("2026-11-16T14:05") },
  ]);
  // Earlier, long and detailed CRM discussions that out-rank the short revision below.
  for (const [i, day] of ["01", "03", "05", "07", "09"].entries()) {
    S[`crmOld${i}`] = await addSession(db, userId, [
      { user: `CRM shortlist CRM shortlist research part ${i}: CRM features, CRM shortlist pricing`, assistant: "CRM shortlist CRM shortlist CRM details.", at: at(`2026-11-${day}T10:00`) },
    ]);
  }
  S.crmRevision = await addSession(db, userId, [
    { user: "In the CRM shortlist replace Close with Salesforce", assistant: "Done.", at: at("2026-11-18T11:00") },
  ]);
  S.email = await addSession(db, userId, [
    { user: "Compare email marketing tools: Mailchimp vs Brevo", assistant: "Brevo is cheaper for large lists.", at: at("2026-11-12T09:00") },
  ]);
});

const ids = (r: Awaited<ReturnType<typeof run>>[number]) => r.sessions.map((s) => s.sessionId);

describe("date filtering by dateSide (question asked 23:59 Mon, answered 00:01 Tue)", () => {
  it('"What did I ask on Tuesday?" excludes it (user side was Monday)', async () => {
    const [r] = await run([question({ query: "what the user asked", timePhrase: "on Tuesday", dateSide: "user" })]);
    expect(ids(r!)).not.toContain(S.midnight!.sessionId);
  });
  it('"What did you tell me on Tuesday?" includes it (assistant side was Tuesday)', async () => {
    const [r] = await run([question({ query: "what the assistant said", timePhrase: "on Tuesday", dateSide: "assistant" })]);
    expect(ids(r!)).toContain(S.midnight!.sessionId);
  });
  it('"What did we discuss on Monday?" includes it (either side)', async () => {
    const [r] = await run([question({ query: "what we discussed", timePhrase: "on Monday", dateSide: "either" })]);
    expect(r!.status).toBe("found");
    expect(ids(r!)).toEqual(expect.arrayContaining([S.midnight!.sessionId, S.crmMonday!.sessionId]));
    expect(r!.searched).toBe("Mon 16 Nov only");
  });
  it("topic questions get the same hard filter", async () => {
    const q = question({ query: "pgbouncer pool size", keywords: ["pgbouncer", "pool"], timePhrase: "on Tuesday", dateSide: "user" });
    const [r] = await run([q]);
    expect(r!.status).toBe("none_on_date");
    const q2 = question({ query: "pgbouncer pool size", keywords: ["pgbouncer", "pool"], timePhrase: "on Tuesday", dateSide: "assistant" });
    expect(ids((await run([q2]))[0]!)).toEqual([S.midnight!.sessionId]);
  });
});

describe("none_on_date", () => {
  it("nothing on the date → nearest match elsewhere, labelled as such", async () => {
    const [r] = await run([question({ query: "Postgres hosting pricing", keywords: ["Postgres", "hosting"], timePhrase: "last Tuesday", dateSide: "user" })]);
    expect(r!.status).toBe("none_on_date");
    expect(r!.sessions).toEqual([]);
    expect(r!.searched).toBe("Tue 17 Nov only (your messages)");
    expect(r!.nearestElsewhere).toMatchObject({ sessionId: S.postgresOld!.sessionId, date: "Tue 10 Nov" });
  });
  it("date-only question with an empty day → nearest session in time", async () => {
    const [r] = await run([question({ query: "what the user asked", timePhrase: "on 14 November", dateSide: "user" })]);
    expect(r!.status).toBe("none_on_date");
    expect(r!.nearestElsewhere).toBeDefined();
  });
});

describe("topic search", () => {
  it("returns every matching chat, with no cap: the short later revision and all the long earlier ones", async () => {
    const [r] = await run([question({ query: "CRM shortlist", keywords: ["CRM", "shortlist"], wantsCurrent: true })]);
    expect(r!.status).toBe("found");
    expect(ids(r!)).toContain(S.crmRevision!.sessionId); // newest
    for (const i of [0, 1, 2, 3, 4]) expect(ids(r!)).toContain(S[`crmOld${i}`]!.sessionId);
    expect(ids(r!)).toContain(S.crmMonday!.sessionId);
  });
  it("each session appears once, listing every matched exchange with its side", async () => {
    const [r] = await run([question({ query: "drop from CRM shortlist", keywords: ["CRM", "shortlist", "drop"] })]);
    const monday = r!.sessions.filter((s) => s.sessionId === S.crmMonday!.sessionId);
    expect(monday).toHaveLength(1);
    expect(monday[0]!.matches.map((m) => m.exchangeId)).toEqual(S.crmMonday!.exchangeIds);
  });
  it("skips the current session", async () => {
    const [r] = await run([question({ query: "email marketing tools Mailchimp Brevo", keywords: ["Mailchimp", "Brevo"] })], S.email!.sessionId);
    expect(r!.status).toBe("no_match");
  });
  it("no match anywhere → no_match with what was searched", async () => {
    const [r] = await run([question({ query: "Kubernetes autoscaling", keywords: ["Kubernetes", "autoscaling"] })]);
    expect(r).toMatchObject({ status: "no_match", searched: "all history", sessions: [] });
  });
  it("around: the date weights, it doesn't filter", async () => {
    const [r] = await run([question({ query: "Postgres hosting", keywords: ["Postgres", "hosting"], timePhrase: "around Wednesday" })]);
    expect(r!.status).toBe("found");
    expect(ids(r!)).toContain(S.postgresOld!.sessionId); // 8 days away, still returned
  });
  it("is deterministic", async () => {
    const qs = [question({ query: "CRM shortlist", keywords: ["CRM", "shortlist"], wantsCurrent: true }), question({ queryId: "q2", query: "Postgres", keywords: ["Postgres"] })];
    expect(await run(qs)).toEqual(await run(qs));
  });
});

describe("every memory (a broad question)", () => {
  it("returns every memory of the user, oldest first, without searching, except the current chat's", async () => {
    const add = async (session: { sessionId: string; exchangeIds: string[] }, text: string, when: Date) => {
      const [vec] = await fakeEmbedder.embed([text], "document");
      await db.query(
        `INSERT INTO memories (id, user_id, session_id, exchange_id, kind, speaker, topic, entities, text, hash, occurred_at, embedding, fts)
         VALUES ($1, $2, $3, $4, 'preference', 'user', 't', '{}', $5, $6, $7, $8::vector, to_tsvector('english', $5))`,
        [randomUUID(), userId, session.sessionId, session.exchangeIds[0], text, randomUUID(), when, toVector(vec!)],
      );
    };
    await add(S.email!, "The user's newsletter goes to clinic owners.", at("2026-11-12T09:00"));
    await add(S.postgresOld!, "The user builds a meal-planning app.", at("2026-11-10T15:00"));
    await add(S.crmRevision!, "The user's founder is Karan.", at("2026-11-18T11:00"));
    // Nothing here matches "kubernetes" by keyword or meaning: a broad question doesn't search at all.
    const [r] = await run([question({ query: "kubernetes", keywords: ["kubernetes"], allMemories: true })], S.crmRevision!.sessionId);
    expect(r).toMatchObject({ status: "found", all: true, searched: "every memory", sessions: [] });
    expect(r!.memories.map((m) => m.text)).toEqual(["The user builds a meal-planning app.", "The user's newsletter goes to clinic owners."]);
  });
});
