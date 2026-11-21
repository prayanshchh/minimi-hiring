import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { withFallback } from "../src/models";

// The Answerer's fallback: a busy model must not stall the turn.

type StreamOptions = { abortSignal?: AbortSignal };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const replies = (text: string) => async () => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ] as never[],
  }),
});
const overloaded = async (): Promise<never> => {
  throw new Error("This model is currently experiencing high demand. Spikes in demand are usually temporary.");
};
/** Never responds; rejects only when its request is aborted (like a held HTTP request). */
const hangs = (o: StreamOptions) => new Promise<never>((_, reject) => o.abortSignal?.addEventListener("abort", () => reject(o.abortSignal!.reason)));

const call = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never;
const fallbackOptions = { google: { thinkingConfig: { thinkingLevel: "low" } } };

describe("withFallback", () => {
  it("uses the main model when it starts in time", async () => {
    const main = new MockLanguageModelV3({ doStream: replies("main") });
    const backup = new MockLanguageModelV3({ doStream: replies("backup") });
    const onFallback = vi.fn();
    await withFallback(main, { model: backup, providerOptions: fallbackOptions }, { firstResponseMs: 1000, onFallback }).doStream(call);
    expect(main.doStreamCalls).toHaveLength(1);
    expect(backup.doStreamCalls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back when the main model errors, with the fallback's own provider options", async () => {
    const main = new MockLanguageModelV3({ doStream: overloaded });
    const backup = new MockLanguageModelV3({ doStream: replies("backup") });
    const onFallback = vi.fn();
    await withFallback(main, { model: backup, providerOptions: fallbackOptions }, { firstResponseMs: 1000, onFallback }).doStream(call);
    expect(backup.doStreamCalls).toHaveLength(1);
    expect(backup.doStreamCalls[0]!.providerOptions).toEqual(fallbackOptions);
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("high demand"));
  });

  it("falls back when the main model doesn't start responding in time", async () => {
    const main = new MockLanguageModelV3({ doStream: hangs as never });
    const backup = new MockLanguageModelV3({ doStream: replies("backup") });
    const onFallback = vi.fn();
    const started = Date.now();
    await withFallback(main, { model: backup, providerOptions: fallbackOptions }, { firstResponseMs: 40, onFallback }).doStream(call);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(backup.doStreamCalls).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("didn't start responding within"));
  });

  it("does not fall back when the caller aborts", async () => {
    const main = new MockLanguageModelV3({ doStream: hangs as never });
    const backup = new MockLanguageModelV3({ doStream: replies("backup") });
    const onFallback = vi.fn();
    const abort = new AbortController();
    setTimeout(() => abort.abort(new Error("user went away")), 10);
    await expect(
      withFallback(main, { model: backup, providerOptions: fallbackOptions }, { firstResponseMs: 1000, onFallback }).doStream({ ...(call as object), abortSignal: abort.signal } as never),
    ).rejects.toThrow("user went away");
    expect(backup.doStreamCalls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("without a fallback, a stalled model fails with a clear error instead of hanging", async () => {
    const main = new MockLanguageModelV3({ doStream: hangs as never });
    await expect(withFallback(main, null, { firstResponseMs: 40, onFallback: vi.fn() }).doStream(call)).rejects.toThrow(/didn't start responding within 0.04s/);
  });

  it("non-streaming calls (Planner, Memory Writer) fall back too, e.g. when a daily quota runs out", async () => {
    const quota = async (): Promise<never> => {
      throw new Error("You exceeded your current quota. Generate content requests per day limit exceeded on Free Tier.");
    };
    const main = new MockLanguageModelV3({ doGenerate: quota });
    const backup = new MockLanguageModelV3({
      doGenerate: async () => ({ content: [{ type: "text", text: "{}" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
    });
    const onFallback = vi.fn();
    const result = await withFallback(main, { model: backup, providerOptions: fallbackOptions }, { firstResponseMs: 1000, onFallback }).doGenerate(call);
    expect(result.content).toEqual([{ type: "text", text: "{}" }]);
    expect(backup.doGenerateCalls[0]!.providerOptions).toEqual(fallbackOptions);
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("quota"));
  });

  it("works inside streamText: the answer comes from the fallback", async () => {
    const main = new MockLanguageModelV3({ doStream: overloaded });
    const backup = new MockLanguageModelV3({ doStream: replies("hello from the backup") });
    const result = streamText({ model: withFallback(main, { model: backup, providerOptions: fallbackOptions }, { firstResponseMs: 1000, onFallback: () => {} }), prompt: "hi" });
    expect(await result.text).toBe("hello from the backup");
  });
});
