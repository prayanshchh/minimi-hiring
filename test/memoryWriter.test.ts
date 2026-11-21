import { describe, expect, it } from "vitest";
import { quotedFromUser } from "../src/memoryWriter";

describe("a memory's quote must be the user's own words in that message", () => {
  const message = "Hi! I'm Riya. I run sales at a 20-person B2B SaaS startup in Bengaluru. We sell appointment-scheduling software to clinics.";

  it("accepts an exact passage, ignoring case, spacing and end punctuation", () => {
    expect(quotedFromUser("I run sales at a 20-person B2B SaaS startup", message)).toBe(true);
    expect(quotedFromUser("  i RUN sales at a   20-person b2b saas startup in Bengaluru.", message)).toBe(true);
  });

  it("accepts curly quotes and dashes for straight ones", () => {
    expect(quotedFromUser("I’m Riya", message)).toBe(true);
    expect(quotedFromUser("flights are booked for 12–22 March", "Japan update: flights are booked for 12-22 March.")).toBe(true);
  });

  it("accepts two passages joined with an ellipsis, if both are there", () => {
    expect(quotedFromUser("I'm Riya... in Bengaluru", message)).toBe(true);
    expect(quotedFromUser("I'm Riya… in Mumbai", message)).toBe(false);
  });

  it("rejects words from anywhere else: the assistant's reply, another message, a paraphrase", () => {
    expect(quotedFromUser("Close Essentials as the first trial", message)).toBe(false);
    expect(quotedFromUser("two of them are vegan", message)).toBe(false);
    expect(quotedFromUser("I work in sales in Bengaluru", message)).toBe(false);
  });

  it("rejects an empty or trivial quote", () => {
    expect(quotedFromUser("", message)).toBe(false);
    expect(quotedFromUser(" . ", message)).toBe(false);
    expect(quotedFromUser("I", message)).toBe(false);
  });
});
