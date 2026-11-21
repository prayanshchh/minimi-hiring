/**
 * One synthetic user, Riya, told through 40 dated messages in 20 chats (2–20 Nov 2026), then 10
 * test questions asked "today", each in a new chat. Written BEFORE the agent ran, so the
 * expectations below are what memory should hold, not a description of what it does.
 *
 * Per message:
 *   must  facts the Memory Writer should store (a memory may combine several)
 *   ok    acceptable either way: not needed, but not noise
 *   avoid tempting things that must NOT become memories
 * Every message also falls under the global rules in NEVER_STORE.
 */

export type Msg = { text: string; must?: string[]; ok?: string[]; avoid?: string[] };
export type Chat = { at: string; messages: Msg[] };
/** A test chat: one question, optionally a follow-up in the same chat. */
export type Test = { text: string; look: string; followUp?: { text: string; look: string } };

export const TIMEZONE = "Asia/Kolkata";

export const NEVER_STORE = [
  "What the user asked or wanted to know (\"the user asked about Notion pricing\").",
  "Anything the assistant said: prices, recommendations (films, books, podcasts, restaurants, CRMs), plans, drafts, calculations.",
  "Suggestions the user never agreed to (e.g. a Supabase or Hoka recommendation).",
  "Greetings, small talk, one-off task details (the team-lunch headcount, the cold-email brief).",
  "Anything from the test questions on 21 Nov: they reveal no new facts.",
];

export const CHATS: Chat[] = [
  {
    at: "2026-11-02T09:30",
    messages: [
      {
        text: "Hi! I'm Riya. I run sales at a 20-person B2B SaaS startup in Bengaluru. We sell appointment-scheduling software to clinics.",
        must: ["name is Riya", "runs sales at a 20-person B2B SaaS startup", "based in Bengaluru", "company sells appointment-scheduling software to clinics"],
      },
      {
        text: "We still track our pipeline in Google Sheets. What should a CRM for a team our size absolutely have?",
        must: ["team tracks its pipeline in Google Sheets"],
        avoid: ["the user asked what a CRM should have", "the assistant's must-have feature list"],
      },
      {
        text: "Hard limits from my side: at most $50 per seat per month, and it has to work with Slack and Gmail.",
        must: ["CRM budget at most $50 per seat per month", "CRM must integrate with Slack and Gmail"],
      },
    ],
  },
  {
    at: "2026-11-03T16:20",
    messages: [
      {
        text: "Quick one: what does Notion's Plus plan cost per member per month right now? Our sales playbook lives in Notion.",
        must: ["team keeps its sales playbook in Notion"],
        avoid: ["Notion Plus price"],
      },
      {
        text: "And Slack: what's the price difference between Pro and Business+ per user?",
        ok: ["team uses Slack"],
        avoid: ["Slack prices"],
      },
    ],
  },
  {
    at: "2026-11-04T07:15",
    messages: [
      {
        text: "I run 5k three mornings a week and drink about four cups of filter coffee a day. Is coffee right before a run a bad idea?",
        must: ["runs 5k three mornings a week", "drinks about four cups of filter coffee a day"],
        avoid: ["advice about coffee before running"],
      },
    ],
  },
  {
    at: "2026-11-05T21:10",
    messages: [
      {
        text: "Need a movie for tonight. I love sci-fi and slow-burn psychological thrillers. Interstellar and Arrival are my all-time favourites. Horror is a hard no.",
        must: ["loves sci-fi and slow-burn psychological thrillers", "favourite films are Interstellar and Arrival", "dislikes horror"],
        avoid: ["the films the assistant recommended"],
      },
      {
        text: "Seen Annihilation and Ex Machina already. Anything from the last couple of years?",
        must: ["has already seen Annihilation and Ex Machina"],
        avoid: ["the films the assistant recommended"],
      },
    ],
  },
  {
    at: "2026-11-06T19:30",
    messages: [
      {
        text: "Recommend a podcast about sales or startups for my runs. I like interviews, not lectures.",
        must: ["prefers interview-style podcasts over lectures"],
        ok: ["listens to podcasts while running", "interested in sales/startup podcasts"],
        avoid: ["the podcasts the assistant recommended"],
      },
    ],
  },
  {
    at: "2026-11-07T12:45",
    messages: [
      {
        text: "I'm vegetarian and trying to cook more on weekends. Give me a paneer dish I can make in 30 minutes.",
        must: ["is vegetarian", "trying to cook more on weekends"],
        avoid: ["the recipe"],
      },
      {
        text: "Truthfully, my comfort food is masala dosa. On lazy days I just order it on Swiggy. Which Bengaluru places are famous for it?",
        must: ["comfort food is masala dosa", "orders from Swiggy on lazy days"],
        avoid: ["the restaurants the assistant listed"],
      },
    ],
  },
  {
    at: "2026-11-08T17:00",
    messages: [
      {
        text: "I'm a morning person, up at 5:30 every day. Help me plan a week that fits running, my day job and my side project.",
        must: ["morning person who wakes at 5:30 every day", "has a side project"],
        avoid: ["the weekly plan the assistant wrote"],
      },
      {
        text: "Keep Sunday completely free. That's family day.",
        must: ["Sundays are family day and kept free"],
      },
    ],
  },
  {
    at: "2026-11-09T10:05",
    messages: [
      {
        text: "Half my team is in the field visiting clinics. Which CRMs have a genuinely good mobile app?",
        must: ["half the sales team works in the field visiting clinics"],
        ok: ["CRM needs a good mobile app"],
        avoid: ["the CRMs the assistant named"],
      },
      {
        text: "Can a CRM log calls and emails from Gmail and Google Meet automatically, so reps stop updating the sheet by hand?",
        ok: ["wants automatic call/email logging from Gmail and Google Meet", "team uses Google Meet"],
      },
    ],
  },
  {
    at: "2026-11-10T10:15",
    messages: [
      {
        text: "Different topic: on weekends I'm building a meal-planning app for busy parents, on Postgres. What managed Postgres options have a free tier?",
        must: ["side project: a meal-planning app for busy parents, built on weekends, on Postgres"],
        avoid: ["the free tiers the assistant listed"],
      },
      {
        text: "Would Supabase's free tier hold up for around 500 users at launch?",
        ok: ["expects about 500 users at launch"],
        avoid: ["a decision to use Supabase (none was made)"],
      },
    ],
  },
  {
    at: "2026-11-11T22:30",
    messages: [
      {
        text: "Just finished Project Hail Mary and loved it. What should I read next for that same science-heavy, funny vibe?",
        must: ["read and loved Project Hail Mary", "likes science-heavy, funny sci-fi books"],
        avoid: ["the books the assistant recommended"],
      },
      {
        text: "I also read a lot of practical business books. The Mom Test changed how I run discovery calls. Any sales books in that style?",
        must: ["reads a lot of practical business books", "has read The Mom Test and it shaped their discovery calls"],
        avoid: ["the books the assistant recommended"],
      },
    ],
  },
  {
    at: "2026-11-12T13:00",
    messages: [
      {
        text: "I'm organising lunch for my whole team, 20 people, near our office in Indiranagar. Most of them are vegetarian. Ideas?",
        must: ["office is in Indiranagar"],
        ok: ["most of the team is vegetarian"],
        avoid: ["organising a team lunch (one-off)", "the restaurants the assistant listed"],
      },
      {
        text: "Two of them are vegan and one has a nut allergy. Does that change your picks?",
        ok: ["two teammates are vegan and one has a nut allergy"],
        avoid: ["the revised restaurant picks"],
      },
    ],
  },
  {
    at: "2026-11-13T07:10",
    messages: [
      {
        text: "Big news: I signed up for the Tata Mumbai Marathon half in January. How should I build up from 5k runs?",
        must: ["signed up for the Tata Mumbai Marathon half marathon in January 2027"],
        avoid: ["the training plan"],
      },
      {
        text: "My knees ache after longer runs. Are cushioned shoes like the Hoka Clifton worth the price?",
        must: ["knees ache after longer runs"],
        avoid: ["a decision to buy Hoka Clifton (none was made)"],
      },
    ],
  },
  {
    at: "2026-11-14T18:40",
    messages: [
      {
        text: "My partner and I are planning 10 days in Japan in March. Is the JR Pass still worth it for Tokyo, Kyoto and Osaka?",
        must: ["planning a 10-day Japan trip (Tokyo, Kyoto, Osaka) with their partner in March 2027"],
        ok: ["has a partner"],
        avoid: ["the assistant's JR Pass verdict"],
      },
      {
        text: "Someone has to look after Mochi, our beagle, while we're away. How do I pick a good pet sitter in Bengaluru?",
        must: ["has a beagle named Mochi"],
        ok: ["needs a pet sitter for Mochi during the Japan trip"],
      },
    ],
  },
  {
    at: "2026-11-16T09:00",
    messages: [
      {
        text: "I read about three books a month, mostly on my commute. Is the Kindle Paperwhite worth it over the basic Kindle?",
        must: ["reads about three books a month, mostly on the commute"],
        avoid: ["a decision to buy a Kindle (none was made)"],
      },
      {
        text: "I commute by metro from Whitefield to Indiranagar, about 40 minutes each way, if that changes anything.",
        must: ["commutes by metro from Whitefield to Indiranagar, about 40 minutes each way"],
        ok: ["lives in Whitefield"],
      },
    ],
  },
  {
    at: "2026-11-16T14:02",
    messages: [
      {
        text: "CRM time. For our 20-person team (under $50 a seat, Slack and Gmail integration, solid mobile app), give me 5 options with monthly per-seat prices.",
        ok: ["CRM needs a solid mobile app (only if not stored on 9 Nov)"],
        avoid: ["the 5 options and prices the assistant gave", "duplicates of the budget/integration facts"],
      },
      {
        text: "Salesforce feels too heavy for us, so leave it out. We'll shortlist these 5: HubSpot Sales Hub, Pipedrive, Zoho CRM, Freshsales and Close. I'm taking that list to my founder.",
        must: ["decision (Mon 16 Nov 2026): CRM shortlist is HubSpot Sales Hub, Pipedrive, Zoho CRM, Freshsales and Close", "Salesforce left out as too heavy"],
        ok: ["taking the shortlist to the founder"],
      },
    ],
  },
  {
    at: "2026-11-17T15:30",
    messages: [
      {
        text: "Back to my meal-planning app: compare Neon, Supabase and Render for Postgres, entry paid tier, monthly price.",
        avoid: ["the prices the assistant gave"],
      },
      {
        text: "Decision: I'll start on Neon's free plan and move to the Launch plan once I have paying users.",
        must: ["decision (Tue 17 Nov 2026): meal-planning app starts on Neon's free plan, moves to Neon Launch once it has paying users"],
      },
    ],
  },
  {
    at: "2026-11-18T11:00",
    messages: [
      {
        text: "Update on the CRM shortlist: my founder doesn't want Close. It's built for inside sales, and we're mostly field sales. Drop it and add Salesforce Starter, since he's used Salesforce before.",
        must: ["decision (Wed 18 Nov 2026): Close dropped (built for inside sales; team is mostly field sales), Salesforce Starter added; full list HubSpot Sales Hub, Pipedrive, Zoho CRM, Freshsales, Salesforce Starter"],
        ok: ["the founder has used Salesforce before", "team is mostly field sales"],
      },
      {
        text: "Also, after the demos the reps loved Pipedrive, so it's our front-runner now.",
        must: ["Pipedrive is the CRM front-runner after the demos (18 Nov 2026)"],
      },
    ],
  },
  {
    at: "2026-11-18T20:30",
    messages: [
      {
        text: "Japan update: flights are booked for 12–22 March. What's the cherry blossom outlook for Kyoto around then?",
        must: ["Japan flights booked for 12–22 March 2027"],
        avoid: ["the cherry blossom forecast"],
      },
      {
        text: "We've decided to skip the JR Pass and use IC cards plus a single Shinkansen ticket.",
        must: ["decision (Wed 18 Nov 2026): skipping the JR Pass, using IC cards plus one Shinkansen ticket"],
      },
    ],
  },
  {
    at: "2026-11-19T08:20",
    messages: [
      {
        text: "Small update about me: I've started eating eggs again, so I'm vegetarian plus eggs now. Any high-protein breakfast ideas for long-run days?",
        must: ["now eats eggs: vegetarian plus eggs, no longer strictly vegetarian (states old and new)"],
        avoid: ["the breakfast ideas"],
      },
      {
        text: "We watched Dune: Part Two last night and loved it. Anything similar in scale and tone?",
        must: ["has seen and loved Dune: Part Two"],
        avoid: ["the films the assistant recommended"],
      },
    ],
  },
  {
    at: "2026-11-20T13:30",
    messages: [
      {
        text: "Draft a 3-line cold email to clinic owners about our scheduling software. Friendly, no buzzwords.",
        ok: ["prefers a friendly, buzzword-free tone in sales emails"],
        avoid: ["the email draft"],
      },
      {
        text: "Our quarterly target is ₹1.2 crore and we're at 70%. At an average deal size of ₹1.5 lakh, how many more deals do we need?",
        ok: ["quarterly sales target is ₹1.2 crore", "average deal size is ₹1.5 lakh"],
        avoid: ["\"at 70% of target\" (changes weekly)", "the number of deals the assistant computed"],
      },
      {
        text: "Remember for later: our founder's name is Karan, and he signs off on any tool over ₹2 lakh a year.",
        must: ["founder's name is Karan", "Karan signs off on any tool over ₹2 lakh a year"],
      },
    ],
  },
];

/** Asked today (21 Nov 2026), each in a new chat. None should create a memory. */
export const TESTS: Test[] = [
  { text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", look: "finds the Mon 16 Nov 14:02 chat (not the 09:00 Kindle chat); names HubSpot, Pipedrive, Zoho, Freshsales, Close; checks each against today's web; ideally notes Close was later swapped for Salesforce Starter" },
  { text: "What did I ask you on 3 November? Is your answer still correct today?", look: "Notion Plus price and Slack Pro vs Business+; re-checked on the web" },
  { text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", look: "Tue 17 Nov (Neon vs Supabase vs Render), not the 10 Nov free-tier chat; re-checked; mentions the Neon decision" },
  { text: "What's on our CRM shortlist right now, after all the changes?", look: "HubSpot Sales Hub, Pipedrive (front-runner), Zoho CRM, Freshsales, Salesforce Starter; Close dropped" },
  { text: "Recommend a movie for tonight based on what you know about me.", look: "sci-fi or slow-burn thriller, no horror, not Interstellar/Arrival/Annihilation/Ex Machina/Dune: Part Two" },
  { text: "I'm hungry and lazy. What should I order, and from where?", look: "masala dosa on Swiggy; vegetarian (eggs OK)" },
  { text: "What should I read next? You know my taste.", look: "science-heavy funny sci-fi or practical business/sales; not Project Hail Mary or The Mom Test" },
  { text: "Remind me: what race am I training for, and when is it?", look: "Tata Mumbai Marathon half, January 2027" },
  { text: "What did we talk about on Sunday 15 November?", look: "nothing that day; offers the nearest chat (Sat 14 Nov Japan, or Mon 16 Nov)" },
  { text: "What do you know about me so far?", look: "a faithful profile: work, habits, tastes, plans, decisions; vegetarian plus eggs; nothing invented" },
];

// ── The hard set ─────────────────────────────────────────────────────────────
/**
 * 16 more history messages, slotted between Riya's chats (Sunday 15 Nov stays empty), built on
 * the cases that break memory: the agent proposes a list, the user changes it, then accepts it;
 * a proposal the user never accepts; a decision the user reverses; facts that change (team size,
 * delivery app, sign-off limit); "the second one you listed". Then 27 tougher test chats.
 */
export const HARD_CHATS: Chat[] = [
  {
    at: "2026-11-10T16:00",
    messages: [
      { text: "We want to start a monthly newsletter for clinic owners. Suggest 5 email marketing tools that work for a small B2B team.", must: ["wants to start a monthly newsletter for clinic owners"], avoid: ["the 5 tools the agent suggested"] },
      { text: "Drop anything that costs more than $30 a month for 1,000 contacts. We also need a decent free plan to start.", must: ["newsletter tool: at most $30 a month for 1,000 contacts", "newsletter tool: needs a decent free plan to start"], avoid: ["the revised list"] },
      { text: "Swap out the last one on your list for something with stronger automation.", ok: ["wants strong email automation"], avoid: ["any list as chosen: the user is still changing the agent's proposal"] },
      { text: "Perfect, let's go with the top 3 from that list.", must: ["decision (Tue 10 Nov 2026): the newsletter tools are the top 3 of the agent's latest list in this chat, by name"], avoid: ["tools that were dropped along the way"] },
    ],
  },
  {
    at: "2026-11-14T10:00",
    messages: [
      { text: "We're planning a two-day team offsite in mid-December. Suggest 3 venues within 3 hours of Bengaluru for 20 people.", must: ["planning a two-day team offsite in mid-December 2026 near Bengaluru"], avoid: ["the venues the agent suggested"] },
      { text: "Hmm, let me think about these and check with Karan first.", avoid: ["any venue as chosen or booked"] },
    ],
  },
  {
    at: "2026-11-17T18:00",
    messages: [
      { text: "For my meal-planning app I need a project management tool, just for me. Give me 3 options.", ok: ["works on the side project alone"], avoid: ["the 3 tools the agent suggested"] },
      { text: "The second one you listed looks right for me. Let's go with that.", must: ["decision (Tue 17 Nov 2026): picked the second tool of the agent's list for the side project, by name"] },
    ],
  },
  {
    at: "2026-11-18T22:45",
    messages: [
      { text: "Finished The Martian on my new Kindle Paperwhite. Loved it even more than Project Hail Mary!", must: ["read and loved The Martian, even more than Project Hail Mary", "owns a Kindle Paperwhite"], avoid: ["the agent's next-book suggestions"] },
    ],
  },
  {
    at: "2026-11-19T17:00",
    messages: [
      { text: "Correction for the CRM maths: we're 24 people in sales now, we hired 4 reps this week. Does that push any of our shortlist over budget?", must: ["the sales team is now 24 people (was 20)"], avoid: ["the agent's cost calculations"] },
    ],
  },
  {
    at: "2026-11-19T21:00",
    messages: [
      { text: "Change of plan for Japan: we're adding a day trip to Hiroshima, so I think the 7-day JR Pass is worth it after all. Let's get it.", must: ["decision (Thu 19 Nov 2026): adding a Hiroshima day trip and getting the 7-day JR Pass, reversing the 18 Nov plan to skip it"] },
      { text: "Also, we've booked Priya from PawSpace to look after Mochi while we're away.", must: ["decision: Priya from PawSpace is booked to look after Mochi during the Japan trip"] },
      { text: "What's the easiest way to do Kyoto to Hiroshima and back in one day?", avoid: ["the route the agent suggested"] },
    ],
  },
  {
    at: "2026-11-20T18:00",
    messages: [{ text: "FYI Karan bumped the sign-off threshold to ₹3 lakh a year.", must: ["Karan's sign-off threshold is now ₹3 lakh a year (was ₹2 lakh)"] }],
  },
  {
    at: "2026-11-20T20:00",
    messages: [{ text: "Swiggy's fees have gotten ridiculous, so I've switched to Zomato for food delivery now.", must: ["now orders food from Zomato instead of Swiggy"] }],
  },
  {
    at: "2026-11-21T08:30",
    messages: [
      { text: "Morning! Ran 12k today, my longest run ever, and my knees felt fine in the new Hoka Cliftons.", must: ["owns Hoka Clifton running shoes, and the knees felt fine in them"], ok: ["ran 12k on Sat 21 Nov 2026, the longest run so far"] },
    ],
  },
];

/** Asked after all the history, each in a new chat. None should create a memory. */
export const HARD_TESTS: Test[] = [
  { text: "Which email tools did we settle on for the clinic newsletter?", look: "the 3 tools accepted on Tue 10 Nov (top 3 of the agent's last list in that chat), not the first 5 or the dropped ones" },
  { text: "What did you first suggest for the newsletter, before I asked for changes?", look: "the agent's original 5, presented as its suggestions, not decisions" },
  { text: "Did we book a venue for the December offsite?", look: "no: suggestions only, on Sat 14 Nov; Riya wanted to check with Karan first" },
  { text: "Are we getting the JR Pass for Japan?", look: "yes, the 7-day pass, decided Thu 19 Nov for the Hiroshima day trip, reversing the 18 Nov decision to skip it" },
  { text: "Who's looking after Mochi while we're in Japan?", look: "Priya from PawSpace, booked Thu 19 Nov" },
  { text: "I'm hungry and lazy. What should I order, and from where?", look: "masala dosa on Zomato (switched from Swiggy on Fri 20 Nov); vegetarian, eggs fine" },
  { text: "If we buy Pipedrive Growth for the whole sales team on annual billing, will it need Karan's sign-off?", look: "24 seats (not 20) and the ₹3 lakh limit (not ₹2 lakh): about $11K a year, roughly ₹9–10 lakh, so yes" },
  { text: "What should I read next? You know my taste.", look: "not Project Hail Mary, The Martian or The Mom Test; fits science-heavy funny sci-fi or practical business books" },
  { text: "Should I buy a Kindle Paperwhite?", look: "you already have one (said Wed 18 Nov)" },
  { text: "What did I ask you on Tuesday 10 November?", look: "two chats: Postgres free tiers + Supabase for 500 users (10:15), newsletter tools (16:00)" },
  { text: "What did we talk about on Wednesday 18 November?", look: "three chats: CRM swap + Pipedrive front-runner (11:00), Japan flights + skipping the JR Pass (20:30), finishing The Martian (22:45)" },
  { text: "Last week you told me Freshsales was the cheapest CRM on our shortlist, right?", look: "corrects the false premise from the transcripts instead of agreeing; says what was actually said" },
  { text: "How many separate chats have we had about CRMs, and what changed in each?", look: "Mon 2 Nov (needs), Mon 9 Nov (mobile apps, call logging), Mon 16 Nov (options + shortlist), Wed 18 Nov (Close → Salesforce Starter, Pipedrive leads), Thu 19 Nov (team now 24); nothing invented" },
  { text: "Which project management tool did I pick for my side project?", look: "the second tool of the agent's Tue 17 Nov list, by name" },
  { text: "What did you recommend for my knee pain?", look: "the agent's 13 Nov advice, as the agent's (cushioned shoe on sale, slow build-up, physio if it persists)" },
  { text: "How far did I run this morning, and how were my knees?", look: "12k, longest ever; knees fine in the new Hoka Cliftons" },
  { text: "Has anything changed with Neon's pricing since we decided to use it?", look: "decision Tue 17 Nov (free plan, then Launch); re-checks Launch prices against the 17 Nov snapshots" },
  {
    text: "What's on the shortlist?",
    look: "two shortlists exist (CRM; email tools): gives both, or asks which",
    followUp: { text: "The CRM one. Which of those suits a team that's mostly out in the field?", look: "the current CRM list (no Close) and the field-sales need (mobile apps)" },
  },
  { text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", look: "Mon 16 Nov list (with Close), verdict per tool; ideally notes Close → Salesforce Starter and the team now being 24" },
  { text: "What did I ask you on 3 November? Is your answer still correct today?", look: "Notion Plus, Slack Pro vs Business+; re-checked" },
  { text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", look: "the Tue 17 Nov 15:30 Postgres chat (not the 18:00 project-tool chat, not 10 Nov); re-checked" },
  { text: "What did we decide about Kubernetes autoscaling?", look: "nothing found; nothing invented" },
  { text: "When did I first mention my side project, and what is it?", look: "first mentioned Sun 8 Nov (planning the week); named Tue 10 Nov: a meal-planning app for busy parents, on Postgres" },
  { text: "What do you know about my running?", look: "5k three mornings a week; Tata Mumbai half on 17 Jan 2027; knee ache on long runs; 12k this morning, fine in new Cliftons; interview podcasts on runs" },
  { text: "When is my marathon, and has the race date changed since I signed up?", look: "Sun 17 Jan 2027 (from 13 Nov); re-checked on the web" },
  { text: "What did you tell me about the cherry blossoms in Kyoto, and is it still accurate?", look: "the agent's 18 Nov outlook for 12–22 March, as the agent's; re-checked" },
  { text: "What do you know about me so far?", look: "a full, current profile: 24 in sales, Zomato, JR Pass yes, Karan ₹3 lakh, owns a Paperwhite and Cliftons, read The Martian; old values only as what changed" },
];

/** "riya": the first 40 + 10. "hard": the same 40 plus HARD_CHATS in date order, then HARD_TESTS. */
export function dataset(name: string): { chats: Chat[]; tests: Test[] } {
  if (name === "riya") return { chats: CHATS, tests: TESTS };
  if (name === "hard") return { chats: [...CHATS, ...HARD_CHATS].sort((a, b) => a.at.localeCompare(b.at)), tests: HARD_TESTS };
  throw new Error(`Unknown dataset "${name}": use riya or hard`);
}

// ── Expected "request" memories (Memory Writer v4) ───────────────────────────
/**
 * What the request memory for each history message should say, written before the run, keyed by
 * the start of the message. null = no request (the message only states facts or decisions);
 * "either" = a request is fine but not needed. Every test question should get exactly one request
 * and nothing else.
 */
export const EXPECTED_REQUESTS: Array<[string, string | null | "either"]> = [
  ["Hi! I'm Riya", null],
  ["We still track our pipeline", "what a CRM for a team their size must have"],
  ["Hard limits from my side", null],
  ["Quick one: what does Notion", "what Notion's Plus plan costs per member per month"],
  ["And Slack: what's the price", "the price difference between Slack Pro and Business+ per user"],
  ["I run 5k three mornings", "whether coffee right before a run is a bad idea"],
  ["Need a movie for tonight", "a movie for tonight"],
  ["Seen Annihilation and Ex Machina", "films from the last couple of years"],
  ["Recommend a podcast", "a sales or startup podcast for runs"],
  ["I'm vegetarian and trying to cook", "a paneer dish that takes 30 minutes"],
  ["Truthfully, my comfort food", "Bengaluru places famous for masala dosa"],
  ["I'm a morning person", "a weekly plan that fits running, the day job and the side project"],
  ["Keep Sunday completely free", "either"],
  ["Half my team is in the field", "which CRMs have a good mobile app"],
  ["Can a CRM log calls", "whether a CRM can log calls and emails from Gmail and Google Meet automatically"],
  ["Different topic: on weekends", "managed Postgres options with a free tier"],
  ["Would Supabase's free tier", "whether Supabase's free tier holds up for about 500 users at launch"],
  ["We want to start a monthly newsletter", "5 email marketing tools for a small B2B team"],
  ["Drop anything that costs more than", "drop tools over $30 a month for 1,000 contacts"],
  ["Swap out the last one", "swap the last tool on the list for one with stronger automation"],
  ["Perfect, let's go with the top 3", null],
  ["Just finished Project Hail Mary", "what to read next with the same science-heavy, funny vibe"],
  ["I also read a lot of practical", "sales books in the style of The Mom Test"],
  ["I'm organising lunch", "lunch ideas for the 20-person team near the Indiranagar office"],
  ["Two of them are vegan", "whether two vegans and a nut allergy change the picks"],
  ["Big news: I signed up", "how to build up from 5k runs"],
  ["My knees ache after longer runs", "whether cushioned shoes like the Hoka Clifton are worth the price"],
  ["We're planning a two-day team offsite", "3 offsite venues within 3 hours of Bengaluru for 20 people"],
  ["Hmm, let me think about these", null],
  ["My partner and I are planning", "whether the JR Pass is worth it for Tokyo, Kyoto and Osaka"],
  ["Someone has to look after Mochi", "how to pick a good pet sitter in Bengaluru"],
  ["I read about three books a month", "whether the Kindle Paperwhite is worth it over the basic Kindle"],
  ["I commute by metro", "either"],
  ["CRM time.", "5 CRM options with monthly per-seat prices"],
  ["Salesforce feels too heavy", null],
  ["Back to my meal-planning app", "a comparison of Neon, Supabase and Render entry paid tiers"],
  ["Decision: I'll start on Neon", null],
  ["For my meal-planning app I need", "3 project management tool options"],
  ["The second one you listed", null],
  ["Update on the CRM shortlist", "either"],
  ["Also, after the demos", null],
  ["Japan update: flights are booked", "the cherry blossom outlook for Kyoto around 12–22 March 2027"],
  ["We've decided to skip the JR Pass", null],
  ["Finished The Martian", null],
  ["Small update about me", "high-protein breakfast ideas for long-run days"],
  ["We watched Dune", "films similar to Dune: Part Two"],
  ["Correction for the CRM maths", "whether 24 people push any of the shortlist over budget"],
  ["Change of plan for Japan", null],
  ["Also, we've booked Priya", null],
  ["What's the easiest way to do Kyoto", "the easiest way to do Kyoto to Hiroshima and back in a day"],
  ["Draft a 3-line cold email", "a 3-line cold email to clinic owners"],
  ["Our quarterly target is", "how many more deals are needed to hit the target"],
  ["Remember for later", null],
  ["FYI Karan bumped", null],
  ["Swiggy's fees have gotten", null],
  ["Morning! Ran 12k today", null],
];

/** The expected request for a history message, by the start of its text. */
export function expectedRequest(text: string): string | null | "either" | undefined {
  return EXPECTED_REQUESTS.find(([start]) => text.startsWith(start))?.[1];
}
