import type { QuoteSource } from "./promptBuilder";

/**
 * Quote verifier, in the streaming layer. The Answerer may quote past messages only as
 *   <q ex="ex_81" side="user">…</q>
 * Tokens pass straight through until a "<q" opens; then we buffer to "</q>" and check that the
 * quoted words really appear (whitespace/case-normalised) in THAT exchange's named side.
 * Verified → re-emitted as a styled quote (with its timestamp). Not verified → plain text + a warning.
 * So "you said X" can never put words in the user's mouth.
 */

const MAX_QUOTE_BUFFER = 800; // an unclosed <q> longer than this is not a quote
const CLOSE = "</q>";

export function createQuoteVerifier(lookup: (ref: string) => QuoteSource | undefined, warn: (msg: string) => void = console.warn) {
  let buf = "";
  let inQuote = false;

  function drain(final: boolean): string {
    let out = "";
    while (true) {
      if (!inQuote) {
        const i = buf.indexOf("<q");
        const stray = buf.indexOf(CLOSE);
        if (stray !== -1 && (i === -1 || stray < i)) { // a closing tag with no opening one: drop it
          out += buf.slice(0, stray);
          buf = buf.slice(stray + CLOSE.length);
          continue;
        }
        if (i === -1) {
          const hold = final ? 0 : partialTagAtEnd(buf); // maybe the start of "<q" or "</q>"
          out += buf.slice(0, buf.length - hold);
          buf = buf.slice(buf.length - hold);
          return out;
        }
        if (i + 2 >= buf.length && !final) { // can't tell "<q " from "<qux" yet
          out += buf.slice(0, i);
          buf = buf.slice(i);
          return out;
        }
        const after = buf[i + 2];
        if (after !== " " && after !== ">") { // not a quote tag
          out += buf.slice(0, i + 2);
          buf = buf.slice(i + 2);
          continue;
        }
        out += buf.slice(0, i);
        buf = buf.slice(i);
        inQuote = true;
      }
      const end = buf.indexOf(CLOSE);
      if (end === -1) {
        if (final || buf.length > MAX_QUOTE_BUFFER) {
          warn(`[quote] unclosed <q> tag, emitted as plain text`);
          out += stripTags(buf);
          buf = "";
          inQuote = false;
          if (final) return out;
          continue;
        }
        return out;
      }
      const whole = buf.slice(0, end + CLOSE.length);
      buf = buf.slice(end + CLOSE.length);
      inQuote = false;
      out += verify(whole);
    }
  }

  function verify(whole: string): string {
    const m = /^<q\b([^>]*)>([\s\S]*)<\/q>$/.exec(whole);
    const attrs = m?.[1] ?? "";
    // A tag nested inside a quote is never passed on: otherwise a failed outer check would
    // release an inner, forged "verified" tag.
    const inner = stripTags(m?.[2] ?? whole);
    const ex = /\bex\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    const side = /\bside\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    const src = ex ? lookup(ex) : undefined;
    if (src && (side === "user" || side === "assistant") && quoteAppearsIn(inner, src[side])) {
      const at = side === "user" ? src.userAt : src.assistantAt;
      return `<q ex="${ex}" side="${side}" at="${at}">${inner}</q>`;
    }
    warn(`[quote] unverified quote ${ex ?? "?"}/${side ?? "?"}: "${inner.slice(0, 80)}"`);
    return inner;
  }

  return { push: (delta: string) => ((buf += delta), drain(false)), flush: () => drain(true) };
}

/** Removes anything that looks like a quote tag, complete or cut off. */
function stripTags(s: string): string {
  return s.replace(/<\/?q\b[^>]*>?/g, "");
}

/** Length of a trailing "<", "</" or "</q" that may become a tag once the next delta arrives. */
function partialTagAtEnd(s: string): number {
  for (let n = Math.min(3, s.length); n > 0; n--) if (CLOSE.startsWith(s.slice(-n))) return n;
  return 0;
}

/** True if every fragment of the quote (split on ellipses) appears in the source, in order. */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const src = normalize(source.replace(/<\/?q\b[^>]*>/g, ""));
  const fragments = quote.split(/…|\.\.\./).map((f) => normalize(f).replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, "")).filter(Boolean);
  if (!fragments.length) return false;
  let from = 0;
  for (const f of fragments) {
    const at = src.indexOf(f, from);
    if (at === -1) return false;
    from = at + f.length;
  }
  return true;
}

function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
