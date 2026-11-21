import { DateTime } from "luxon";
import type { DB } from "../src/db";
import { completeExchange, getOrCreateUser, startExchange, type NewObservation } from "../src/exchangeStore";
import { writeMemories } from "../src/memoryWriter";
import type { Embedder } from "../src/models";

/**
 * Seed history for reviewers and the eval. Dates are computed from "now" when the seed runs,
 * so "last Monday" in a scenario is last Monday whenever you run it. Everything is written
 * through the normal Exchange Store and Memory Writer code.
 *
 * Prices and page snapshots below are illustrative history, not claims about today's web:
 * the agent is supposed to check them against the live pages and report what changed.
 */

type SeedExchange = { user: string; assistant: string; at: DateTime; repliedAt?: DateTime; observations?: Array<Omit<NewObservation, "observedAt">> };
type SeedSession = { key: string; exchanges: SeedExchange[]; relatedTo?: string[] };

export type SeedTimeline = ReturnType<typeof timeline>;

export function timeline(now: Date, tz: string) {
  const t = DateTime.fromJSDate(now, { zone: tz });
  const today = t.startOf("day");
  /** Most recent past occurrence of a weekday (1 = Mon), strictly before today — same rule as the time resolver. */
  const last = (weekday: number) => today.minus({ days: ((today.weekday - weekday + 7) % 7) || 7 });
  const past = (d: DateTime, fallback: DateTime) => (d < t.minus({ minutes: 30 }) ? d : fallback);
  const lastMonday = last(1);
  const crmMonday = lastMonday.set({ hour: 14, minute: 2 });
  return {
    now: t,
    crmMonday,
    // "Two days later" — clamped so it's never in the future when the seed runs early in the week.
    crmRevision: past(lastMonday.plus({ days: 2 }).set({ hour: 11 }), t.minus({ hours: 1 })),
    postgresTuesday: last(2).set({ hour: 15, minute: 30 }),
    postgresEarlier: last(2).minus({ days: 7 }).set({ hour: 10, minute: 15 }),
    emailThursday: last(4).set({ hour: 9, minute: 40 }),
    offsite: today.minus({ days: 5 }).set({ hour: 10 }),
    // Asked 23:59 on a Monday, answered 00:01 Tuesday. A week earlier if that Tuesday 00:01 is still ahead.
    midnightAsk: past(lastMonday.plus({ days: 1 }), lastMonday.minus({ days: 6 })).minus({ minutes: 1 }),
    datedQuestion: today.minus({ days: 17 }).set({ hour: 16, minute: 20 }),
  };
}

function sessions(d: SeedTimeline): SeedSession[] {
  const m = (base: DateTime, minutes: number) => base.plus({ minutes });
  const obsMonday = { query: "CRM pricing per seat 2026" };
  return [
    // 1 + 2. Monday: the original shortlist with prices and snapshots, and a proposal the user never accepts.
    {
      key: "crmMonday",
      exchanges: [
        {
          at: d.crmMonday,
          user: "We need a CRM for our 20-person sales team. Shortlist 5 tools with per-seat pricing.",
          assistant:
            "Here's a shortlist for a 20-person sales team (per seat, per month, billed annually):\n\n1. HubSpot Sales Hub Professional: $90/seat [1]\n2. Pipedrive Essential: $14/seat [2]\n3. Close Growth: $99/seat [3]\n4. Zoho CRM Professional: $23/seat [4]\n5. Freshsales Pro: $39/seat [5]\n\nPipedrive and Zoho are cheapest; HubSpot has the strongest marketing integration.",
          observations: [
            { url: "https://www.hubspot.com/pricing/sales", title: "Sales Hub Pricing | HubSpot", searchQuery: obsMonday.query, excerpt: "## Sales Hub\n| Plan | Price (billed annually) |\n|---|---|\n| Starter | $15/mo per seat |\n| Professional | $90/mo per seat |\n| Enterprise | $150/mo per seat |\nForecasting: Professional and above" },
            { url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive pricing", searchQuery: obsMonday.query, excerpt: "## Plans\n| Plan | Billed annually |\n|---|---|\n| Essential | $14 per seat/month |\n| Advanced | $34 per seat/month |\n| Professional | $49 per seat/month |" },
            { url: "https://www.close.com/pricing", title: "Close CRM Pricing", searchQuery: obsMonday.query, excerpt: "## Pricing\n| Plan | Annual billing |\n|---|---|\n| Essentials | $35/user/mo |\n| Growth | $99/user/mo |\n| Scale | $139/user/mo |" },
            { url: "https://www.zoho.com/crm/zohocrm-pricing.html", title: "Zoho CRM Pricing", searchQuery: obsMonday.query, excerpt: "## Editions (billed annually)\n| Edition | Price |\n|---|---|\n| Standard | $14/user/month |\n| Professional | $23/user/month |\n| Enterprise | $40/user/month |" },
            { url: "https://www.freshworks.com/crm/pricing/", title: "Freshsales Pricing", searchQuery: obsMonday.query, excerpt: "## Freshsales plans (billed annually)\n| Plan | Price |\n|---|---|\n| Growth | $9/user/month |\n| Pro | $39/user/month |\n| Enterprise | $59/user/month |\nSales forecasting: Pro and above" },
          ],
        },
        {
          at: m(d.crmMonday, 6),
          user: "Which one would you drop first?",
          assistant: "I'd drop Freshsales first: forecasting needs the Pro plan, and at $39/seat you'd get more from Zoho CRM Professional at $23/seat.",
        },
        {
          at: m(d.crmMonday, 11),
          user: "Hmm, let me think about that. How long does onboarding usually take for each?",
          assistant: "Roughly: Pipedrive and Freshsales 1–2 weeks, Zoho CRM 2–3 weeks, HubSpot 3–4 weeks with Professional onboarding, Close about 1 week.",
        },
      ],
    },
    // 1. Two days later, a new chat: the revision.
    {
      key: "crmRevision",
      relatedTo: ["crmMonday"],
      exchanges: [
        {
          at: d.crmRevision,
          user: "About the CRM shortlist for the sales team: replace Close with Salesforce Starter. Close is too pricey for 20 seats.",
          assistant: "Done. The shortlist is now HubSpot Sales Hub, Pipedrive, Salesforce Starter, Zoho CRM and Freshsales. Salesforce Starter is $25/user/month billed annually [1], versus $99 for Close Growth.",
          observations: [
            { url: "https://www.salesforce.com/sales/pricing/", title: "Sales Cloud Pricing | Salesforce", searchQuery: "Salesforce Starter pricing", excerpt: "## Starter Suite\n$25 USD/user/month (billed annually)\nSimple CRM suite with marketing, sales and service." },
          ],
        },
      ],
    },
    // 3. Last Tuesday: Postgres hosting. The Supabase snapshot contradicts what the assistant said.
    {
      key: "postgresTuesday",
      exchanges: [
        {
          at: d.postgresTuesday,
          user: "What are good managed Postgres hosting options for a small SaaS app, and what do they cost?",
          assistant:
            "Good options for a small SaaS app (entry paid tier, monthly):\n\n- Neon Launch: $19/month [1]\n- Supabase Pro: $20/month [2]\n- Render Postgres Basic-1gb: $19/month [3]\n\nNeon and Supabase both have generous free tiers if you want to start there.",
          observations: [
            { url: "https://neon.com/pricing", title: "Neon Pricing", searchQuery: "managed Postgres hosting pricing", excerpt: "## Plans\n| Plan | Price |\n|---|---|\n| Free | $0 |\n| Launch | $19/month |\n| Scale | $69/month |" },
            { url: "https://supabase.com/pricing", title: "Pricing & Fees | Supabase", searchQuery: "managed Postgres hosting pricing", excerpt: "## Pricing\n| Plan | Price |\n|---|---|\n| Free | $0/month |\n| Pro | From $25/month |\n| Team | From $599/month |" },
            { url: "https://render.com/pricing", title: "Pricing | Render", searchQuery: "managed Postgres hosting pricing", excerpt: "## Postgres\n| Instance | RAM | Price |\n|---|---|---|\n| Basic-256mb | 256 MB | $6/month |\n| Basic-1gb | 1 GB | $19/month |" },
          ],
        },
      ],
    },
    // Hard filters: an earlier Postgres chat that "last Tuesday" must NOT pick up.
    {
      key: "postgresEarlier",
      exchanges: [
        {
          at: d.postgresEarlier,
          user: "Is Heroku Postgres still a good choice for hosting a hobby project?",
          assistant: "For a hobby project Heroku Postgres Essential-0 at $5/month works, but Neon's or Supabase's free tiers cost nothing.",
        },
      ],
    },
    // 4. Thursday: email tools. "What did I ask about email marketing on Tuesday?" → none that day, nearest Thursday.
    {
      key: "emailThursday",
      exchanges: [
        {
          at: d.emailThursday,
          user: "Compare email marketing tools for a newsletter with 8,000 subscribers: Mailchimp vs Brevo vs Kit.",
          assistant: "For 8,000 subscribers: Brevo is cheapest because it charges by emails sent, not contacts; Kit is built for creators; Mailchimp has the most templates but costs the most at that list size.",
        },
      ],
    },
    // 5. A long session (32 exchanges) whose answer is the final exchange.
    { key: "offsite", exchanges: offsiteSession(d.offsite) },
    // 6. Across midnight: asked 23:59 Monday, answered 00:01 Tuesday.
    {
      key: "midnight",
      exchanges: [
        {
          at: d.midnightAsk,
          repliedAt: d.midnightAsk.plus({ minutes: 2 }),
          user: "Quick one before bed: how should I size the pgbouncer connection pool for our Postgres?",
          assistant: "Start with default_pool_size ≈ 2 × the database's CPU cores, use transaction pooling, and watch cl_waiting; raise it only if clients queue.",
        },
      ],
    },
    // "What did I ask you on <date>? Is your answer still correct today?"
    {
      key: "datedQuestion",
      exchanges: [
        {
          at: d.datedQuestion,
          user: "What's the latest stable Python release? Should we upgrade our services from 3.12?",
          assistant: "The latest stable release is Python 3.15.0, released on 1 October 2026 [1]. Upgrading from 3.12 is worth planning: 3.12 only gets security fixes now, but check your dependencies' wheels first.",
          observations: [
            { url: "https://www.python.org/downloads/", title: "Download Python | Python.org", searchQuery: "latest Python release", excerpt: "## Active Python releases\n| Version | Status | First released |\n|---|---|---|\n| 3.15 | bugfix | 2026-10-01 |\n| 3.14 | bugfix | 2025-10-07 |\n| 3.12 | security | 2023-10-02 |" },
          ],
        },
      ],
    },
  ];
}

function offsiteSession(start: DateTime): SeedExchange[] {
  const pairs: Array<[string, string]> = [
    ["We're planning a 3-day offsite for our 12-person product team in April. Where do we start?", "Start with goals, budget and dates, then pick the city and venue around them."],
    ["Goals: H2 strategy, team bonding, and a hackathon day.", "Good mix: day 1 strategy, day 2 hackathon, day 3 bonding activities."],
    ["Budget is about €18,000 all-in.", "That's about €1,500 per person: enough for flights within Europe, 3 nights, a venue and food."],
    ["Candidate cities: Lisbon, Porto, Barcelona.", "Lisbon has the best flight links, Porto is cheapest, Barcelona is priciest in April."],
    ["What's the weather like in April?", "Lisbon around 19°C, Porto 17°C, Barcelona 18°C; Porto is the most likely to rain."],
    ["Which dates avoid Easter?", "Easter 2027 is on 28 March, so mid-April (e.g. 14–16 April) avoids it."],
    ["How should we structure the hackathon?", "Teams of 3–4, a 9:00 kickoff, demos at 17:00, and one shared theme tied to the H2 strategy."],
    ["Team-bonding ideas in Lisbon?", "A surf lesson in Cascais, a tile-painting workshop, or a sunset sail on the Tagus."],
    ["Dietary planning: two vegans and one coeliac.", "Tell the venue and caterer early; ask for a separate gluten-free prep area."],
    ["What venue options are there in Lisbon?", "Three to consider: the LX Factory event space, Village Underground Lisboa, or a hotel meeting room."],
    ["What's the difference between LX Factory and Village Underground?", "LX Factory has breakout rooms and AV included; Village Underground is cheaper and more informal, with one big room."],
    ["Hotels near LX Factory?", "Alcântara and Belém have several 4-star hotels within 10 minutes; ask for a 12-room group block."],
    ["Flights from Berlin and London?", "Both have direct flights to Lisbon of about 3 hours; book together for group fares."],
    ["Does anyone need visas?", "EU and UK citizens don't need one for Portugal; check any non-EU passports individually."],
    ["Draft a day 1 agenda.", "9:30 kickoff, 10:00 H2 strategy review, 13:00 lunch, 14:00 priorities workshop, 17:00 wrap-up, 20:00 team dinner."],
    ["What facilitation style suits the strategy session?", "Silent brainstorming then dot-voting keeps quieter people in the conversation."],
    ["Should we hire a facilitator?", "For 12 people it's optional; an internal lead who isn't the manager works fine."],
    ["Swag ideas?", "Something useful: a good water bottle or a tote bag with the offsite theme."],
    ["How do we collect dietary needs and T-shirt sizes?", "One short form sent with the announcement, due two weeks before."],
    ["One person can't travel. How do we include them?", "Give them a buddy on site, a good conference mic in the room, and a hackathon role that works remotely."],
    ["Ground transport from the airport?", "The metro takes 25 minutes; for 12 people with luggage, two pre-booked vans are easier."],
    ["Dinner spots for 12 people?", "Book ahead: Time Out Market has group tables; a seafood place in Cais do Sodré is a good second night."],
    ["Do we need travel insurance?", "Check the company policy first; most cover business travel within Europe."],
    ["A good icebreaker for day 1?", "'Two truths and a lie, work edition' takes 15 minutes and works for any team."],
    ["How early should we book?", "Venue and hotel 8–10 weeks ahead for April; flights 6–8 weeks ahead."],
    ["Can we get group discounts on flights?", "TAP and easyJet offer group bookings from 10 passengers; ask for a quote."],
    ["Write a short announcement for the team.", "'Save the date: our product offsite is in Lisbon in April. Three days of strategy, a hackathon and some sun. Details soon!'"],
    ["What prizes for the hackathon?", "Small and fun: the winning team picks the day 3 activity, plus a trophy that travels to the next offsite."],
    ["A rain plan for the sail day?", "Book a tile-painting workshop as a refundable backup for the same afternoon."],
    ["Venue quotes came in: LX Factory €4,200 and Village Underground €3,100 for the 3 days.", "Both fit the €18,000 budget. Village Underground saves €1,100, but LX Factory has the breakout rooms you'll want for the hackathon."],
    ["Everyone confirmed that 14–16 April works.", "Great: 14–16 April 2027 it is. Next step is the venue."],
    ["OK, final decision: Lisbon, 14–16 April, and we book LX Factory because of the breakout rooms. Lock it in.", "Locked in: Lisbon, 14–16 April 2027, at the LX Factory event space (€4,200 for 3 days). Next: send the hotel group-block request and the announcement."],
  ];
  return pairs.map(([user, assistant], i) => ({ user, assistant, at: start.plus({ minutes: i * 3 }) }));
}

/** Writes the scenarios for a fresh user. Returns the user id and session id per scenario key. */
export async function seedDatabase(
  deps: { db: DB; embedder: Embedder },
  opts: { now: Date; timezone: string; concurrency?: number; onProgress?: (msg: string) => void },
) {
  const d = timeline(opts.now, opts.timezone);
  const user = await getOrCreateUser(deps.db, undefined, opts.timezone);
  const sessionIds: Record<string, string> = {};
  const exchangeIds: Record<string, string[]> = {};
  const jobs: Array<{ exchangeId: string; relatedExchangeIds: string[] }> = [];

  for (const s of sessions(d)) {
    let sessionId: string | null = null;
    exchangeIds[s.key] = [];
    const related = (s.relatedTo ?? []).flatMap((k) => exchangeIds[k] ?? []);
    for (const e of s.exchanges) {
      const { exchange, session } = await startExchange(deps.db, { userId: user.id, sessionId, text: e.user, sentAt: e.at.toJSDate() });
      sessionId = session.id;
      const repliedAt = (e.repliedAt ?? e.at.plus({ minutes: 1 })).toJSDate();
      await completeExchange(deps, {
        exchangeId: exchange.id, userText: e.user, assistantText: e.assistant, sentAt: repliedAt,
        observations: (e.observations ?? []).map((o) => ({ ...o, observedAt: repliedAt })),
      });
      exchangeIds[s.key]!.push(exchange.id);
      jobs.push({ exchangeId: exchange.id, relatedExchangeIds: related });
    }
    sessionIds[s.key] = sessionId!;
    opts.onProgress?.(`stored ${s.key} (${s.exchanges.length} exchanges)`);
  }

  // Memories: the same writeMemories() the background queue runs, two at a time. Retries back off
  // for about a minute in total, because free-tier model quotas are per minute.
  let done = 0;
  const total = jobs.length;
  const workers = Array.from({ length: opts.concurrency ?? 2 }, async () => {
    while (jobs.length) {
      const job = jobs.shift()!;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await writeMemories(deps, job);
          break;
        } catch (err) {
          if (attempt === 5) opts.onProgress?.(`memory extraction failed for one exchange (it will be retried when the server starts): ${(err as Error).message}`);
          else await new Promise((r) => setTimeout(r, 6_000 * attempt));
        }
      }
      if (++done % 5 === 0 || done === total) opts.onProgress?.(`memories: ${done}/${total} exchanges processed`);
    }
  });
  await Promise.all(workers);
  return { userId: user.id, timeline: d, sessionIds, exchangeIds };
}
