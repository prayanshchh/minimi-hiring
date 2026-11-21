/**
 * Every tunable number in the agent lives here, with the reason for its value.
 * The two relevance-floor thresholds are starting values: tune them with `npm run eval`
 * (it asserts which sessions each scenario retrieves).
 */
export const config = {
  // ── Planner ────────────────────────────────────────────────────────────
  /** Recent exchanges of the current chat the Planner sees, to resolve "it", "those tools", etc. */
  PLANNER_HISTORY_EXCHANGES: 10,
  /** Characters kept per message when showing chat history to the Planner (it only needs gist). */
  PLANNER_HISTORY_CHARS: 600,

  // ── Retriever ──────────────────────────────────────────────────────────
  /** How deep each ranked list (FTS / vector × exchanges / memories) is searched. Search depth, not a cap on what is handed over: the relevance bar decides that. */
  CANDIDATES_PER_LIST: 500,
  /** Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper. */
  RRF_K: 60,
  /**
   * Relevance floor, part 1. RRF is rank-based, so it cannot say "irrelevant": the nearest
   * neighbour of an unrelated query still ranks first. A candidate must therefore carry absolute
   * evidence: cosine similarity >= this, from any vector list... Each embedding model has its own
   * cosine scale, so the floor is per provider. Starting values: `npm run eval` prints the
   * similarities of expected vs unrelated sessions to tune them.
   */
  VECTOR_MIN_SIMILARITY: { local: 0.45, google: 0.55, openai: 0.35 }, // local: on Riya's chats, 0.45 kept the right chat for 10/10 questions and let 13 of 280 wrong ones through
  /** ...or (part 2) contain at least this share of the planned keywords' stems (Postgres FTS). */
  FTS_MIN_COVERAGE: 0.5,
  /** "around Tuesday": score multiplier by distance in local days from the anchor day. */
  AROUND_DAY_WEIGHTS: [1.0, 0.85, 0.75, 0.65],
  /** Beyond the table above, each further day costs this much, down to AROUND_MIN_WEIGHT. */
  AROUND_DECAY_PER_DAY: 0.05,
  AROUND_MIN_WEIGHT: 0.3,
  /** "Date-only" around-questions read this many days either side of the anchor. */
  AROUND_DATE_ONLY_DAYS: 3,
  /** wantsCurrent: at most +10% for the newest candidates, applied after the floor. */
  RECENCY_BOOST_MAX: 0.1,
  RECENCY_HALF_LIFE_DAYS: 14,
  /** Question names a speaker ("why did *you* suggest"): hits on that speaker's side get ×1.1. */
  SPEAKER_BOOST: 1.1,
  /** "What did we talk about last time?" (no date, no topic): the most recent sessions... */
  LATEST_SESSIONS: 2,
  /** ...with this many of their final exchanges marked as matches. */
  LATEST_EXCHANGES_PER_SESSION: 3,

  // ── Context Packer ─────────────────────────────────────────────────────
  /**
   * Every past chat goes into the prompt in full. Only beyond this many tokens of history (the
   * model reads 1M) are the oldest chats the search didn't find left out. Note: Claude Haiku 5.5
   * bills a whole request at 5x once its prompt passes 100K tokens.
   */
  HISTORY_MAX_TOKENS: 600_000,
  /** Token estimate for the cap above. Measured on this app's transcripts with Haiku 5.5's own counts: 2.3–2.5 chars per token. */
  CHARS_PER_TOKEN: 2.3,
  /** Guard against a pasted document: a single message longer than this is cut, with a marker saying so. */
  MAX_MESSAGE_CHARS: 50_000,
  /** Web result text per turn, across all searches (about 10K tokens). */
  WEB_CONTEXT_CHARS: 38_400,

  // ── Answerer / web search ──────────────────────────────────────────────
  /**
   * A model call that hasn't started responding by now goes to FALLBACK_MODEL. An overloaded model
   * can answer 503/529 after 10-20s, or hold the request for minutes; a healthy one starts within a
   * few seconds.
   */
  MODEL_FIRST_RESPONSE_MS: 20_000,
  /**
   * A backstop, not a budget: after this many tool rounds the model must answer with what it has.
   * Normal questions use 1-4; it only stops a model that keeps re-searching from looping forever.
   */
  MAX_TOOL_ROUNDS: 10,
  /** Past chats returned by one read_past_chats call. */
  MAX_CHATS_PER_READ: 5,
  WEB_DEFAULT_RESULTS: 5,
  WEB_MAX_RESULTS: 8,
  /** Per-search timeout. A slow search becomes "couldn't verify", never a stuck turn. */
  WEB_TIMEOUT_MS: 20_000,
  /** Re-crawl pages older than this: "has pricing changed since Monday" needs this week's page. */
  WEB_MAX_AGE_HOURS: 24,
  WEB_LIVECRAWL_TIMEOUT_MS: 10_000,
  /** Page text requested per result; the prompt gets a budget-limited slice of it. */
  WEB_FETCH_TEXT_CHARS: 12_000,
  /** Upper bound on the text shown to the model per result (the web budget may lower it). */
  WEB_RESULT_PROMPT_CHARS: 3_500,
  /** Saved snapshot ("observation") excerpt size: a passage or table with its headers. */
  OBSERVATION_EXCERPT_CHARS: 2_000,

  // ── Memory Writer ──────────────────────────────────────────────────────
  /** Existing memories shown to the extractor so it doesn't repeat them. */
  MEMORY_SIMILAR_EXISTING: 10,
  MEMORY_SESSION_HISTORY: 10,
  MEMORY_MAX_ATTEMPTS: 3,
  MEMORY_BACKOFF_MS: 1_000,
  /** Bump to re-extract every exchange on next startup (old memories of an exchange are replaced). */
  EXTRACTOR_VERSION: 4, // 4: adds "request" memories (what the user asked); facts inside questions; years always written

  // ── Misc ───────────────────────────────────────────────────────────────
  /** Vector size. EmbeddingGemma's native size; gemini-embedding-001 and text-embedding-3-small are asked for the same. */
  EMBEDDING_DIMENSIONS: 768,
  /** Text embedded per exchange: EmbeddingGemma reads 2,048 tokens, and the question + start of the answer carry the topic. */
  EMBEDDING_MAX_CHARS: 8_000,
  /** Query-embedding cache entries: identical follow-up queries reuse identical vectors. */
  EMBEDDING_CACHE_SIZE: 500,
  SSE_KEEPALIVE_MS: 10_000,
  SESSION_TITLE_CHARS: 60,
} as const;
