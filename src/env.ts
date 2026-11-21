import "dotenv/config";

/** Environment, read once. Keys are checked by `assertKeys()` at startup, not at import, so tests need none. */
export const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  EXA_API_KEY: process.env.EXA_API_KEY ?? "",
  MAIN_MODEL: process.env.MAIN_MODEL || "anthropic:claude-sonnet-5-5",
  SMALL_MODEL: process.env.SMALL_MODEL || "anthropic:claude-haiku-5-5",
  /** Optional backup, used when a model errors or is slow to start. Unset or "none" means no backup. */
  FALLBACK_MODEL: process.env.FALLBACK_MODEL && process.env.FALLBACK_MODEL !== "none" ? process.env.FALLBACK_MODEL : "",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "local:onnx-community/embeddinggemma-300m-ONNX",
  DATA_DIR: process.env.DATA_DIR || "./data",
  PORT: Number(process.env.PORT || 3000),
};

const KEY_FOR = { google: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;

/** Fails fast with one readable message listing every missing key for the configured models. */
export function assertKeys(opts: { web: boolean }): void {
  const needs = new Map<string, string[]>(); // key → the settings that need it
  const roles: Array<[string, string]> = [["MAIN_MODEL", env.MAIN_MODEL], ["SMALL_MODEL", env.SMALL_MODEL], ["FALLBACK_MODEL", env.FALLBACK_MODEL], ["EMBEDDING_MODEL", env.EMBEDDING_MODEL]];
  for (const [name, spec] of roles) {
    if (!spec) continue;
    const provider = (spec.includes(":") ? spec.split(":")[0] : "openai") as keyof typeof KEY_FOR;
    const key = KEY_FOR[provider];
    if (key && !env[key]) needs.set(key, [...(needs.get(key) ?? []), name]);
  }
  if (opts.web && !env.EXA_API_KEY) needs.set("EXA_API_KEY", ["web search"]);
  if (needs.size) {
    const lines = [...needs].map(([key, uses]) => `${key} (for ${uses.join(", ")})`);
    console.error(`\nMissing environment variables:\n  - ${lines.join("\n  - ")}\n\nPut them in the .env file in the project folder (copy .env.example if it doesn't exist).\n`);
    process.exit(1);
  }
}
