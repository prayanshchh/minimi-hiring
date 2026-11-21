import fs from "node:fs";
import path from "node:path";
import { CHATS, TESTS, type Msg } from "./dataset";

/**
 * Prints a persona run next to its expectations: per message, what memory should hold
 * (must / ok / avoid) and what the Memory Writer actually stored; timings, cost; then the test answers.
 *   npx tsx scripts/persona/report.ts [--dir=./data-persona] [--answers]
 */
const dir = process.argv.find((a) => a.startsWith("--dir="))?.slice(6) ?? "./data-persona";
const showAnswers = process.argv.includes("--answers");
type Usage = { calls: number; maxPrompt: number; cacheRead: number; cacheWrite: number; output: number; over100k: number; cost: number };
type Row = {
  n: number; at: string; text: string; answer: string; error?: string; searches: string[]; kind?: "history" | "test";
  history?: Array<{ what: "chats" | "web"; items: number }>;
  expect?: Pick<Msg, "must" | "ok" | "avoid">; look?: string;
  plan?: { needsWeb: boolean; questions: Array<{ needsMemory: boolean; summary: string }> };
  memory: Array<{ event: string; data: { sessions?: Array<{ title: string; date: string }>; date?: string; nearestElsewhere?: { title: string; date: string } } }>;
  ms: { firstWord?: number; done?: number; memoryWriter?: number };
  memories: Array<{ kind: string; topic: string; text: string }>;
  usage?: { turn: Usage; writer: Usage };
};
const rows = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Row[];
// Runs from before expectations were stored in run.json used the first Riya set.
const legacy = CHATS.flatMap((c) => c.messages);
for (const r of rows) {
  r.kind ??= r.n <= legacy.length ? "history" : "test";
  if (r.kind === "history") r.expect ??= legacy[r.n - 1];
  else r.look ??= TESTS[r.n - legacy.length - 1]?.look;
}
const s = (ms?: number) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`);

console.log("# Memories: expected vs stored\n");
for (const r of rows) {
  console.log(`## #${r.n} ${r.at}  ${r.text}`);
  const e = r.expect;
  if (r.kind === "test") console.log(`  must   (nothing: test question)`);
  else {
    for (const m of e?.must ?? []) console.log(`  must   ${m}`);
    for (const m of e?.ok ?? []) console.log(`  ok     ${m}`);
    for (const m of e?.avoid ?? []) console.log(`  avoid  ${m}`);
    if (!e?.must?.length && !e?.ok?.length) console.log(`  must   (nothing)`);
  }
  for (const m of r.memories) console.log(`  STORED [${m.kind}] ${m.text}`);
  if (!r.memories.length) console.log(`  STORED (none)`);
  console.log();
}

console.log("# Timing and cost\n");
const turns = rows.filter((r) => r.ms.done);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
for (const [label, pick] of [["first word", (r: Row) => r.ms.firstWord ?? 0], ["done", (r: Row) => r.ms.done ?? 0], ["memory writer", (r: Row) => r.ms.memoryWriter ?? 0]] as const) {
  const xs = turns.map(pick);
  console.log(`${label.padEnd(14)} median ${s(pct(xs, 0.5))}  p90 ${s(pct(xs, 0.9))}  max ${s(Math.max(...xs))}`);
}
for (const [label, f] of [["no web, no memory", (r: Row) => !r.searches.length && !r.memory.length], ["memory, no web", (r: Row) => !r.searches.length && r.memory.length > 0], ["web", (r: Row) => r.searches.length > 0]] as const) {
  const xs = turns.filter(f).map((r) => r.ms.done!);
  if (xs.length) console.log(`${label.padEnd(18)} ${String(xs.length).padStart(2)} turns, median ${s(pct(xs, 0.5))}, max ${s(Math.max(...xs))}`);
}
if (rows.some((r) => r.usage)) {
  const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
  const turnCost = sum((r) => r.usage?.turn.cost ?? 0);
  const writerCost = sum((r) => r.usage?.writer.cost ?? 0);
  const biggest = Math.max(...rows.map((r) => r.usage?.turn.maxPrompt ?? 0));
  const over = rows.filter((r) => (r.usage?.turn.over100k ?? 0) > 0).map((r) => `#${r.n}`);
  console.log(`Claude cost: answers $${turnCost.toFixed(3)}, memory writer $${writerCost.toFixed(3)}; largest prompt ${Math.round(biggest / 1000)}K tokens; prompts over 100K (billed 5x): ${over.join(", ") || "none"}`);
  console.log(`web searches: ${sum((r) => r.searches.length)}`);
  if (rows.some((r) => r.history)) {
    const calls = (what: "chats" | "web", f: (r: Row) => boolean) => rows.filter(f).flatMap((r) => r.history ?? []).filter((h) => h.what === what);
    for (const [label, f] of [["test questions", (r: Row) => r.kind === "test"], ["history messages", (r: Row) => r.kind === "history"]] as const) {
      const chats = calls("chats", f);
      const web = calls("web", f);
      const turns = rows.filter(f).filter((r) => r.history?.length).length;
      console.log(`history tools, ${label}: read past chats ${chats.length}× (${chats.reduce((n, h) => n + h.items, 0)} chats), read saved web results ${web.length}× (${web.reduce((n, h) => n + h.items, 0)} answers), in ${turns} of ${rows.filter(f).length} messages`);
    }
  }
}
console.log(`errors: ${rows.filter((r) => r.error).map((r) => `#${r.n} ${r.error}`).join("; ") || "none"}`);

console.log("\n# Test questions\n");
for (const r of rows.filter((x) => x.kind === "test")) {
  const lookup = r.memory.map((m) => m.event === "memory.found" ? `found ${m.data.sessions!.map((x) => `${x.date} "${x.title.slice(0, 40)}"`).join(", ")}` : m.event === "memory.none_on_date" ? `none on ${m.data.date}; nearest ${m.data.nearestElsewhere?.date ?? "-"}` : m.event === "memory.none" ? "no match" : "").filter(Boolean);
  const u = r.usage?.turn;
  const reads = (r.history ?? []).map((h) => `${h.what === "chats" ? "past chats" : "saved web results"} ×${h.items}`).join(", ");
  console.log(`## #${r.n} ${r.text}\n  look for: ${r.look ?? "-"}\n  lookup:   ${lookup.join(" | ") || "(no memory search)"}\n  read:     ${reads || "(nothing)"}\n  web:     ${r.searches.join(" | ") || "(none)"}\n  time:     ${s(r.ms.done)} (first word ${s(r.ms.firstWord)})${u ? ` · largest prompt ${Math.round(u.maxPrompt / 1000)}K · $${u.cost.toFixed(4)}` : ""}`);
  if (showAnswers) console.log(`\n${r.answer.trim()}\n`);
  console.log();
}
