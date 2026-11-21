<img src="assets/icon.svg" width="64" height="64" alt="">

# Chat agent with web search and dated memory

A chat agent whose only tool is web search, and which remembers past conversations *by date*. Ask "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it finds that exact conversation in your timezone, reads what was actually said (and the pages it cited then), checks the web today, and tells you what changed, what didn't, and what it can't verify.

How it works and why: **[DESIGN.md](DESIGN.md)**.

## Run it

Requires Node 20+.

```bash
cp .env.example .env     # skip if .env already exists; then paste ANTHROPIC_API_KEY and EXA_API_KEY into it
npm install
npm run dev              # http://localhost:3000
```

There's nothing else to set up: the database is PGlite (Postgres in-process), stored in `./data`, and search vectors come from EmbeddingGemma running in-process. The first `npm run dev` downloads that model once (about 315 MB, a couple of minutes, with a progress line) before the server starts, so your first message doesn't wait for it; after that it loads in under a second.

**Cost:** answers run on Claude Sonnet 5.5 ($2 per million input tokens, $10 per million output tokens); planning and memory writing run on Claude Haiku 5.5, Anthropic's small, cheap model ($0.10 / $0.50). A message makes 2 small-model calls and 1–5 answering calls, which comes to a few cents, almost all of it the answer: the Answerer sees only the matching memories and the current chat, and opens past chats only when it needs them. Embeddings are free and local.

### Keys (`.env.example`)

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | planning, answers and memory extraction ([get one](https://console.anthropic.com/settings/keys)) |
| `EXA_API_KEY` | web search |
| `MAIN_MODEL`, `SMALL_MODEL` | Claude models, as `anthropic:<model-id>`. `MAIN_MODEL` answers (default `anthropic:claude-sonnet-5-5`); `SMALL_MODEL` plans and writes memories (default `anthropic:claude-haiku-5-5`) |
| `FALLBACK_MODEL` | optional backup Claude model for all three jobs, used when a model errors or hasn't started replying within 20s (default `none`) |
| `EMBEDDING_MODEL` | default `local:onnx-community/embeddinggemma-300m-ONNX`: runs in-process, no key, because Anthropic has no embedding model. After a change, stored data is re-embedded at startup |

## Try it with a seeded history

```bash
npm run seed     # stop `npm run dev` first: PGlite allows one process per data folder
npm run dev
```

Then open **http://localhost:3000/?seed=1**. This sets the seeded user's cookie. The seed's dates are relative to today ("last Monday" is always last Monday), and it prints the questions to ask, for example:

- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *What was the CRM shortlist on Monday? And what's the current one?* (a later chat swapped one tool)
- *Did we decide to drop Freshsales?* (I suggested it; you never agreed)
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?* (one saved snapshot contradicts what I said)
- *What did I ask about email marketing tools on Tuesday?* (nothing that day; it offers the nearest one)

The seeded prices and page snapshots are illustrative history. Checking them against the live web is the point: expect some to come back as changed.

Seeding makes about 45 small-model calls to write memories, a few cents on Haiku. If a call fails, the seed backs off and retries, and anything still missing is filled in automatically the next time the server starts.

## See what it remembers

Click **View memories** in the sidebar (or open http://localhost:3000/memories.html). It lists what the Memory writer keeps about you: lasting facts ("The user's favourite food is pasta.") and decisions ("On Wed 18 Nov the user replaced Close with Salesforce Starter…"), each with the chat it came from. Questions, small talk and the agent's own words aren't stored: every chat is already saved word for word and searched directly. The raw JSON is at `/api/memories`. Memories are written a second or two after each reply.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | server + chat UI; backfills any missing memories on startup |
| `npm run seed` | creates a demo user with 8 dated sessions (replaces the previous seed) |
| `npm test` | deterministic unit and integration tests (no API keys needed) |
| `npm run eval` | seeds a throwaway in-memory DB, asserts retrieval for every scenario, prints answers. `-- --no-answers` skips web search; `-- --write` updates the results table below |
| `npm run typecheck` | `tsc --noEmit` |

## Tests and evaluation

`npm test` runs 61 deterministic tests that need no API keys or model download. They cover dates and timezones, the Answerer's prompt and its history tools, retrieval on a real database, both quote checks (the answer's and the memories'), and full turns with mocked models.

`npm run eval` seeds the demo scenarios into a throwaway database, checks which chats the Retriever finds for 13 cases, and prints the agent's answers for review. It also prints how well the embedding similarity separates on-topic from off-topic chats, to tune the relevance bar. `npm run eval -- --write` records the results here:

<!-- eval:start -->
Not yet run with live keys. Run `npm run eval -- --write` to fill this table.
<!-- eval:end -->

## Layout

```
src/
  turn.ts            one message end to end: start here
  exchangeStore.ts   exchanges, observations, sessions, users
  planner.ts         questions + needs (small model) → timeResolver.ts (code)
  retriever.ts       hybrid search, hard date filters, the matching memories (no LLM)
  promptBuilder.ts   the Answerer's prompt: current chat + memories + notes
  answerer.ts        tool loop (web search, past chats, saved web results), citations → quoteVerifier.ts
  memoryWriter.ts    background extraction (quote-checked), queue, backfill
  localEmbedder.ts   EmbeddingGemma in-process
  prompts/           every LLM prompt, one file each
  config.ts          every tunable number, with its reason
public/              the chat page (no build step)
scripts/             seed, eval, shared scenarios; persona/ = the 50-message Riya dataset
test/                vitest
```

Each turn's step timings are logged in the terminal. The format looks like this (the numbers are made up):

```
[turn ex_3f9a2c1b] planner       640ms  1 question(s): q1[mem=true exact user] "Postgres hosting providers and their pricing"
[turn ex_3f9a2c1b] retriever      95ms  q1:found(2 chats, 6 memories)
[turn ex_3f9a2c1b] prompt     memories=6 chat≈0t
[turn ex_3f9a2c1b] answerer     9120ms  4 search(es), 3 observation(s)
```
