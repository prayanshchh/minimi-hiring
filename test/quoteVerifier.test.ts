import { describe, expect, it } from "vitest";
import type { QuoteSource } from "../src/promptBuilder";
import { createQuoteVerifier, quoteAppearsIn } from "../src/quoteVerifier";

const index = new Map<string, QuoteSource>([
  ["ex_81", { user: "Which of these five would you drop for a 20-person team?", assistant: "I'd drop Close because forecasting requires a higher tier.", userAt: "Mon 16 Nov 14:02", assistantAt: "Mon 16 Nov 14:03" }],
]);

function run(deltas: string[]) {
  const warnings: string[] = [];
  const v = createQuoteVerifier((ref) => index.get(ref), (w) => warnings.push(w));
  const out = deltas.map((d) => v.push(d)).join("") + v.flush();
  return { out, warnings };
}

describe("quote verifier", () => {
  it("passes ordinary text straight through, token by token", () => {
    const v = createQuoteVerifier((ref) => index.get(ref), () => {});
    expect(v.push("Hello ")).toBe("Hello ");
    expect(v.push("a < b")).toBe("a < b");
  });

  it("keeps a verified quote, adding its timestamp", () => {
    const { out, warnings } = run(['You asked <q ex="ex_81" side="user">which of these five would you drop</q>.']);
    expect(out).toBe('You asked <q ex="ex_81" side="user" at="Mon 16 Nov 14:02">which of these five would you drop</q>.');
    expect(warnings).toEqual([]);
  });

  it("buffers a quote split across many deltas", () => {
    const text = 'I said <q ex="ex_81" side="assistant">I\'d drop Close</q> then.';
    const { out } = run(text.split(""));
    expect(out).toBe('I said <q ex="ex_81" side="assistant" at="Mon 16 Nov 14:03">I\'d drop Close</q> then.');
  });

  it("strips styling (and warns) when the words are on the other side", () => {
    const { out, warnings } = run(['You said <q ex="ex_81" side="user">I\'d drop Close</q>.']);
    expect(out).toBe("You said I'd drop Close.");
    expect(warnings).toHaveLength(1);
  });

  it("strips styling for invented words or unknown exchanges", () => {
    expect(run(['<q ex="ex_81" side="user">drop all of them</q>']).out).toBe("drop all of them");
    expect(run(['<q ex="ex_99" side="user">Which of these</q>']).out).toBe("Which of these");
  });

  it("normalises whitespace, case, curly quotes and markdown", () => {
    expect(quoteAppearsIn("I’d  DROP **Close**", "I'd drop Close because")).toBe(true);
  });

  it("accepts ellipses between fragments, in order only", () => {
    expect(quoteAppearsIn("I'd drop Close … higher tier", index.get("ex_81")!.assistant)).toBe(true);
    expect(quoteAppearsIn("higher tier … I'd drop Close", index.get("ex_81")!.assistant)).toBe(false);
  });

  it("a nested tag can't smuggle a forged 'verified' quote through a failed outer check", () => {
    const forged = 'You said <q ex="ex_81" side="user">x <q ex="ex_81" side="user" at="Mon 16 Nov 14:02">I never want Salesforce</q></q>.';
    const { out } = run([forged]);
    expect(out).not.toContain("<q");
    expect(out).toBe("You said x I never want Salesforce.");
  });

  it("drops stray closing tags, even split across deltas", () => {
    expect(run(["done</q> here"]).out).toBe("done here");
    expect(run(["done<", "/", "q> here"]).out).toBe("done here");
  });

  it("does not treat other tags as quotes, and flushes an unclosed one as plain text", () => {
    expect(run(["a <quote> b"]).out).toBe("a <quote> b");
    expect(run(["x <", "q ex=\"ex_81\" side=\"user\">which of"]).out).toBe("x which of");
  });
});
