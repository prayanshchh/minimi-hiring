import { generateText, Output } from "ai";
import { z } from "zod";
import { config } from "./config";
import type { Exchange } from "./exchangeStore";
import { cacheControl, model, providerOptions } from "./models";
import { PLANNER_SYSTEM, plannerUserPrompt } from "./prompts/planner";
import { dayTimeLabel, local } from "./time";
import { resolveTime, type TimeWindow } from "./timeResolver";

/**
 * Planner: splits the message into questions and decides what each needs.
 * One SMALL_MODEL call returns the plan; code (timeResolver) turns time phrases into windows.
 */

const QuestionSchema = z.object({
  queryId: z.string(),
  needsMemory: z.boolean(),
  query: z.string(),
  keywords: z.array(z.string()),
  timePhrase: z.string().nullable(),
  timeRefersTo: z.enum(["conversation", "event"]).nullable(),
  dateSide: z.enum(["user", "assistant", "either"]),
  wantsCurrent: z.boolean(),
  /** A broad question about the user ("what do you know about me?", "pick a film for me"): send every memory, unfiltered. */
  allMemories: z.boolean(),
});
const PlanSchema = z.object({ questions: z.array(QuestionSchema) });

export type PlannedQuestion = z.infer<typeof QuestionSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** A planned question after code has resolved its time phrase. */
export type ResolvedQuestion = PlannedQuestion & {
  window: TimeWindow;
  /** No topic, only a date ("What did I ask on 3 Nov?"): list what happened, no relevance cut-off. */
  dateOnly: boolean;
  /** The raw user message, searched as a second query with the same date restriction. */
  backupQuery: string | null;
};

export async function plan(input: {
  message: string;
  recent: Exchange[];
  timezone: string;
  now: Date;
}): Promise<{ plan: Plan; questions: ResolvedQuestion[]; fallback: boolean }> {
  const prompt = plannerUserPrompt({
    now: `${local(input.now, input.timezone).toFormat("cccc d LLLL yyyy, HH:mm")}`,
    timezone: input.timezone,
    history: formatHistory(input.recent, input.timezone, input.now),
    message: input.message,
  });

  let result: Plan | null = null;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      const { output } = await generateText({
        model: model("small"),
        system: { role: "system", content: PLANNER_SYSTEM, providerOptions: cacheControl("small") },
        prompt,
        output: Output.object({ schema: PlanSchema }),
        providerOptions: providerOptions("small"),
        maxRetries: 0, // this loop retries, and the model falls back; SDK retries only add delay (a daily-quota 429 can't succeed)
        abortSignal: AbortSignal.timeout(20_000),
      });
      if (output.questions.length) result = output;
    } catch (err) {
      console.warn(`[planner] attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }
  const fallback = !result;
  const final = result ?? fallbackPlan(input.message);
  return { plan: final, questions: final.questions.map((q) => resolveQuestion(q, input.message, input.timezone, input.now)), fallback };
}

export function resolveQuestion(q: PlannedQuestion, rawMessage: string, timezone: string, now: Date): ResolvedQuestion {
  const keywords = q.keywords.map((k) => k.trim()).filter(Boolean);
  // An event date ("Monday's launch") never filters the search; it is just a topic word.
  const window = q.timeRefersTo === "event" ? resolveTime(null, timezone, now) : resolveTime(q.timePhrase, timezone, now);
  return {
    ...q,
    keywords,
    window,
    dateOnly: keywords.length === 0,
    backupQuery: q.needsMemory ? rawMessage : null,
  };
}

/** If the Planner fails twice: one question = the raw message, answered with every memory (the safest guess). */
function fallbackPlan(message: string): Plan {
  return {
    questions: [{ queryId: "q1", needsMemory: true, query: message, keywords: message.split(/\W+/).filter((w) => w.length > 3).slice(0, 6), timePhrase: null, timeRefersTo: null, dateSide: "either", wantsCurrent: false, allMemories: true }],
  };
}

function formatHistory(recent: Exchange[], tz: string, now: Date): string {
  const cut = (s: string) => (s.length > config.PLANNER_HISTORY_CHARS ? `${s.slice(0, config.PLANNER_HISTORY_CHARS)}…` : s);
  return recent
    .slice(-config.PLANNER_HISTORY_EXCHANGES)
    .map((e) => `[User · ${dayTimeLabel(e.userSentAt, tz, now)}] ${cut(e.userText)}\n[Assistant] ${cut(e.assistantText ?? "")}`)
    .join("\n");
}
