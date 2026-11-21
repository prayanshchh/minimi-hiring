import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany, type generateText, type LanguageModel, type wrapLanguageModel } from "ai";
import { config } from "./config";
import { env } from "./env";
import { embedLocally, prepareLocally } from "./localEmbedder";

/**
 * Model wiring. Every model is named "provider:model-id" in .env, so swapping provider is a config
 * change. Defaults: Claude Sonnet 5.5 answers; Claude Haiku 5.5 plans and writes memories; EmbeddingGemma,
 * run locally, for embeddings.
 *   MAIN      = Answerer (quality matters)
 *   SMALL     = Planner (no thinking: latency matters) + Memory Writer (thinks a little: it runs after the reply)
 *   FALLBACK  = optional backup for both, when a model errors or doesn't start answering in time
 *   EMBEDDING = retrieval vectors (local by default: no key, no quota)
 */
type Role = "main" | "small";
type Spec = { provider: Provider; id: string };
/** A concrete model object (not a string id), as the provider packages return it. */
type ModelV3 = Parameters<typeof wrapLanguageModel>[0]["model"];
type CallOptions = Parameters<ModelV3["doStream"]>[0];
type Provider = "google" | "openai" | "anthropic";
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

export function parseSpec(spec: string): Spec {
  const [provider, ...rest] = spec.split(":");
  const id = rest.join(":");
  if ((provider !== "google" && provider !== "openai" && provider !== "anthropic") || !id) {
    throw new Error(`Bad model spec "${spec}". Use "google:<model>", "openai:<model>" or "anthropic:<model>".`);
  }
  return { provider, id };
}

const specOf = (role: Role) => parseSpec(role === "main" ? env.MAIN_MODEL : env.SMALL_MODEL);

const build = ({ provider, id }: Spec): ModelV3 => (provider === "google" ? google(id) : provider === "openai" ? openai(id) : anthropic(id));

/** The small model (Planner, Memory Writer), with FALLBACK_MODEL behind it when one is set. */
export function model(role: Role): LanguageModel {
  if (role === "main") return build(specOf("main"));
  const fallbackSpec = env.FALLBACK_MODEL ? parseSpec(env.FALLBACK_MODEL) : null;
  return withFallback(
    build(specOf("small")),
    fallbackSpec && { model: build(fallbackSpec), providerOptions: optionsFor(fallbackSpec, "small") },
    { firstResponseMs: config.MODEL_FIRST_RESPONSE_MS, onFallback: (reason) => console.warn(`[models] ${env.SMALL_MODEL} failed (${reason}); using ${env.FALLBACK_MODEL}`) },
  );
}

export function modelName(role: Role | "fallback" | "embedding"): string {
  return { main: env.MAIN_MODEL, small: env.SMALL_MODEL, fallback: env.FALLBACK_MODEL || "(none)", embedding: env.EMBEDDING_MODEL }[role];
}

/**
 * How much the model thinks, per role. The small model's jobs (JSON planning, extraction) need
 * none; the Answerer thinks some, for deciding what to search and comparing then-vs-now values.
 */
export function providerOptions(role: Role): ProviderOptions {
  return optionsFor(specOf(role), role);
}

/**
 * The Memory Writer: the small model, thinking a little. Deciding what the user actually said,
 * accepted or only asked about is judgment, and the writer runs after the reply, so no one waits.
 */
export function memoryWriterOptions(): ProviderOptions {
  const spec = specOf("small");
  return spec.provider === "anthropic" ? { anthropic: { effort: "low" } } : optionsFor(spec, "main");
}

function optionsFor({ provider, id }: Spec, role: Role): ProviderOptions {
  if (provider === "google") return { google: { thinkingConfig: geminiThinking(id, role) } };
  if (provider === "openai") return { openai: { reasoningEffort: role === "main" ? "low" : "none" } };
  // Claude 5-generation models: effort sets how much they think. Models that can't turn thinking
  // off (Opus 5.5) get adaptive thinking instead; the provider swaps it and logs a warning.
  return { anthropic: role === "main" ? { effort: "medium" } : { thinking: { type: "disabled" }, effort: "low" } };
}

/** Gemini 2.x takes a token budget; Gemini 3+ and the "-latest" aliases take a level ("minimal" isn't offered on Pro). */
function geminiThinking(id: string, role: Role) {
  if (/^gemini-2\./.test(id)) {
    if (role === "main") return { thinkingBudget: 1024 }; // "a little", like thinkingLevel "low"
    return id.includes("pro") ? {} : { thinkingBudget: 0 }; // Pro can't turn thinking off
  }
  return { thinkingLevel: role === "main" || id.includes("pro") ? ("low" as const) : ("minimal" as const) };
}

/**
 * The Answerer's model: MAIN_MODEL, with FALLBACK_MODEL behind it. A busy model can hold a request
 * for minutes before failing (Gemini answers "high demand" with a 503 after 10-20s, or not at all),
 * so each model call must start responding within MODEL_FIRST_RESPONSE_MS; if it fails or doesn't,
 * that call is sent to the fallback. This applies per call, so a tool loop keeps going on the fallback.
 */
export function answerModel(onFallback: (reason: string) => void): ModelV3 {
  const fallbackSpec = env.FALLBACK_MODEL ? parseSpec(env.FALLBACK_MODEL) : null;
  return withFallback(
    build(specOf("main")),
    fallbackSpec && { model: build(fallbackSpec), providerOptions: optionsFor(fallbackSpec, "main") },
    { firstResponseMs: config.MODEL_FIRST_RESPONSE_MS, onFallback },
  );
}

/**
 * Wraps a model so a failed call is retried once on the fallback (with the fallback's own provider
 * options). Streaming calls must also start within `firstResponseMs`. Exported for tests.
 */
export function withFallback(
  primary: ModelV3,
  fallback: { model: ModelV3; providerOptions: ProviderOptions } | null,
  opts: { firstResponseMs: number; onFallback: (reason: string) => void },
): ModelV3 {
  return {
    specificationVersion: "v3",
    provider: primary.provider,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    async doGenerate(o) {
      try {
        return await primary.doGenerate(o);
      } catch (err) {
        if (o.abortSignal?.aborted || !fallback) throw err;
        opts.onFallback(errorText(err));
        return fallback.model.doGenerate({ ...o, providerOptions: fallback.providerOptions as CallOptions["providerOptions"] });
      }
    },
    async doStream(o) {
      try {
        return await startWithin(primary, o, opts.firstResponseMs);
      } catch (err) {
        if (o.abortSignal?.aborted || !fallback) throw err; // the user's own abort is not a model failure
        opts.onFallback(errorText(err));
        return startWithin(fallback.model, { ...o, providerOptions: fallback.providerOptions as CallOptions["providerOptions"] }, opts.firstResponseMs);
      }
    },
  };
}

/** Calls doStream, failing if the model hasn't started responding within `ms`. The stream itself isn't timed. */
async function startWithin(m: ModelV3, o: CallOptions, ms: number) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`${m.modelId} didn't start responding within ${ms / 1000}s (it may be overloaded)`)), ms);
  try {
    return await m.doStream({ ...o, abortSignal: o.abortSignal ? AbortSignal.any([o.abortSignal, timeout.signal]) : timeout.signal });
  } catch (err) {
    if (timeout.signal.aborted && !o.abortSignal?.aborted) throw timeout.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

/** Anthropic needs an explicit cache marker on the static system prompt; Gemini and OpenAI cache prefixes automatically. */
export function cacheControl(role: Role): ProviderOptions | undefined {
  return specOf(role).provider === "anthropic" ? { anthropic: { cacheControl: { type: "ephemeral" } } } : undefined;
}

// ── Embeddings ─────────────────────────────────────────────────────────────

/** Stored texts (exchanges, memories) and search queries can be embedded differently (Gemini task types). */
export type EmbedKind = "query" | "document";

export type Embedder = {
  name: string;
  /** Unit vectors of config.EMBEDDING_DIMENSIONS. */
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
  /** Relevance floor on this model's cosine scale: scales differ a lot between embedding models. */
  minSimilarity: number;
  /** Gets the model ready before the first message: a local model downloads (first start only) and loads. */
  prepare(): Promise<void>;
};

/**
 * The configured embedding model. Query vectors are cached, so a repeated query gets the
 * identical vector and retrieval stays deterministic for follow-ups.
 */
export function createEmbedder(): Embedder {
  const spec = env.EMBEDDING_MODEL.includes(":") ? env.EMBEDDING_MODEL : `openai:${env.EMBEDDING_MODEL}`;
  const [provider, ...rest] = spec.split(":");
  const id = rest.join(":");
  if (provider !== "local" && provider !== "google" && provider !== "openai") {
    throw new Error(`Bad EMBEDDING_MODEL "${spec}". Use "local:<Hugging Face model id>", "google:<model>" or "openai:<model>" (Anthropic has no embedding models).`);
  }
  const dims = config.EMBEDDING_DIMENSIONS;
  const cache = new Map<string, number[]>();

  return {
    name: spec,
    minSimilarity: config.VECTOR_MIN_SIMILARITY[provider],
    async prepare() {
      if (provider === "local") await prepareLocally(id);
    },
    async embed(texts, kind) {
      const missing = [...new Set(texts.filter((t) => kind === "document" || !cache.has(t)))];
      const fresh = new Map<string, number[]>();
      if (missing.length) {
        const embeddings =
          provider === "local"
            ? await embedLocally(id, missing, kind)
            : (
                await embedMany({
                  model: provider === "google" ? google.embedding(id) : openai.embedding(id),
                  values: missing,
                  providerOptions:
                    provider === "google"
                      ? { google: { outputDimensionality: dims, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" } }
                      : { openai: { dimensions: dims } },
                })
              ).embeddings;
        embeddings.forEach((v, i) => {
          if (v.length !== dims) throw new Error(`${spec} returned ${v.length} dimensions; the schema stores ${dims}.`);
          fresh.set(missing[i]!, normalize(v)); // Gemini only normalises full-size (3072-d) vectors
        });
        if (kind === "query") {
          for (const [t, v] of fresh) cache.set(t, v);
          while (cache.size > config.EMBEDDING_CACHE_SIZE) cache.delete(cache.keys().next().value!);
        }
      }
      return texts.map((t) => fresh.get(t) ?? cache.get(t)!);
    },
  };
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** pgvector literal: "[0.1,0.2,...]". */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
