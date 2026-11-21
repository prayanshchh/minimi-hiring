import { AutoModel, AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer, type ProgressInfo } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";

/**
 * EmbeddingGemma (Google's open-weights embedding model, 300M parameters) running inside this Node
 * process: no API key, no quota, nothing leaves the machine. The 8-bit build (~315 MB) downloads on
 * the first start, with a progress line, and is cached; after that it loads in about half a second.
 * Queries and stored texts get the model's own task prefixes, which it was trained with.
 */
const PREFIX = { query: "task: search result | query: ", document: "title: none | text: " } as const;
const MAX_TOKENS = 2048; // the model's context length
const BATCH = 8;
const SHOWN_FILE_BYTES = 2 * 1024 * 1024; // progress is shown for the tokenizer and the weights, not the small configs

let loading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function load(id: string) {
  if (loading) return loading;
  loading = (async () => {
    const cached = fs.existsSync(path.join(String(env.cacheDir), id, "onnx", "model_quantized.onnx_data"));
    const progress = cached ? undefined : downloadProgress();
    if (progress) console.log(`[embeddings] first start: downloading ${id} (about 315 MB, once)…`);
    const tokenizer = await AutoTokenizer.from_pretrained(id, { progress_callback: progress?.update });
    const model = await AutoModel.from_pretrained(id, { dtype: "q8", progress_callback: progress?.update });
    if (progress) {
      progress.finish();
      console.log("[embeddings] downloaded and ready");
    }
    return { tokenizer, model };
  })();
  loading.catch(() => (loading = null)); // a failed download can be retried
  return loading;
}

/** Downloads the model if needed and loads it, so the first message doesn't wait for it. */
export async function prepareLocally(id: string): Promise<void> {
  await load(id);
}

/** One line per large file: rewritten in place on a terminal, every 10% when output goes to a log. */
function downloadProgress() {
  const tty = Boolean(process.stdout.isTTY);
  const shown = new Map<string, number>(); // file → last percentage printed
  let open = false; // a terminal line still waiting for its newline
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return {
    update(p: ProgressInfo) {
      if (p.status !== "progress" || p.total < SHOWN_FILE_BYTES) return;
      const pct = Math.min(100, Math.floor((p.loaded / p.total) * 100));
      const step = tty ? pct : pct - (pct % 10);
      if (shown.get(p.file) === step) return;
      if (tty && open && !shown.has(p.file)) process.stdout.write("\n"); // the previous file's line ends
      shown.set(p.file, step);
      const line = `[embeddings] ${path.basename(p.file)} ${pct}% (${mb(p.loaded)} of ${mb(p.total)} MB)`;
      if (!tty) return console.log(line);
      process.stdout.write(`\r${line}`);
      open = true;
    },
    finish() {
      if (open) process.stdout.write("\n");
    },
  };
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
