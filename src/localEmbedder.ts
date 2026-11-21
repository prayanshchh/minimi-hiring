import { AutoModel, AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";

/**
 * EmbeddingGemma (Google's open-weights embedding model, 300M parameters) running inside this Node
 * process: no API key, no quota, nothing leaves the machine. The 8-bit build (~309 MB) downloads on
 * first use and is cached; after that it loads in about half a second.
 * Queries and stored texts get the model's own task prefixes, which it was trained with.
 */
const PREFIX = { query: "task: search result | query: ", document: "title: none | text: " } as const;
const MAX_TOKENS = 2048; // the model's context length
const BATCH = 8;

let loading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function load(id: string) {
  loading ??= (async () => {
    if (!fs.existsSync(path.join(String(env.cacheDir), id, "onnx", "model_quantized.onnx_data"))) {
      console.log(`[embeddings] downloading ${id} (about 310 MB, first run only)…`);
    }
    const tokenizer = await AutoTokenizer.from_pretrained(id);
    const model = await AutoModel.from_pretrained(id, { dtype: "q8" });
    return { tokenizer, model };
  })();
  return loading;
}

/** Unit vectors, one per text. Calls run one at a time: the model is a single in-process session. */
export function embedLocally(id: string, texts: string[], kind: "query" | "document"): Promise<number[][]> {
  const run = queue.then(async () => {
    const { tokenizer, model } = await load(id);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => PREFIX[kind] + t);
      const inputs = await tokenizer(batch, { padding: true, truncation: true, max_length: MAX_TOKENS });
      const { sentence_embedding } = (await model(inputs)) as { sentence_embedding: { tolist(): number[][] } };
      out.push(...sentence_embedding.tolist());
    }
    return out;
  });
  queue = run.catch(() => {});
  return run;
}
