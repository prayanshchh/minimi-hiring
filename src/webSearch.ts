import Exa from "exa-js";
import { config } from "./config";
import { env } from "./env";

/**
 * Web search via Exa. We ask for page contents (text + query-relevant highlights), not just links,
 * and force a recrawl of pages older than WEB_MAX_AGE_HOURS: "has it changed since Monday?" is
 * meaningless against a cached copy from last month.
 */
export type WebResult = {
  title: string;
  url: string;
  publishedDate?: string;
  crawledAt?: string;
  highlights: string[];
  text: string;
};

let client: Exa | null = null;
const exa = () => (client ??= new Exa(env.EXA_API_KEY));

export async function webSearch(
  query: string,
  opts: { numResults: number; startPublishedDate?: string | null; signal?: AbortSignal },
): Promise<WebResult[]> {
  const res = await exa().search(
    query,
    {
      type: "auto",
      numResults: opts.numResults,
      // Published-date filter only for news-style queries; the Answerer decides (vendor pages have no useful date).
      ...(opts.startPublishedDate ? { startPublishedDate: opts.startPublishedDate } : {}),
      contents: {
        text: { maxCharacters: config.WEB_FETCH_TEXT_CHARS },
        highlights: { query, maxCharacters: 1_500 },
        maxAgeHours: config.WEB_MAX_AGE_HOURS,
        livecrawlTimeout: config.WEB_LIVECRAWL_TIMEOUT_MS,
      },
    },
    { timeout: config.WEB_TIMEOUT_MS, signal: opts.signal },
  );
  return res.results.map((r) => ({
    title: r.title || r.url,
    url: r.url,
    publishedDate: r.publishedDate,
    crawledAt: r.snapshotAt,
    highlights: r.highlights ?? [],
    text: r.text ?? "",
  }));
}
