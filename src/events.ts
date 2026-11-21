/**
 * Server-Sent Events: every step of a turn is streamed, so the agent never looks stuck.
 * `session` is one addition to the spec's list: a new chat learns its id before the answer starts.
 */
export type AgentEvents = {
  session: { sessionId: string; title: string; isNew: boolean };
  plan: { questions: Array<{ queryId: string; summary: string; needsMemory: boolean }> };
  "memory.search": { queryId: string; searched: string };
  "memory.found": { queryId: string; memories: number; sessions: Array<{ title: string; date: string }>; all?: boolean };
  "memory.none_on_date": { queryId: string; date: string; nearestElsewhere?: { title: string; date: string } };
  "memory.none": { queryId: string; searched: string };
  /** The Answerer read past chats, or the web results saved with past answers. */
  "history.read": { what: "chats" | "web"; items: Array<{ title: string; date: string }> };
  "web.search": { query: string };
  "web.result": { query: string; sources: Array<{ n: number; title: string; url: string }>; error?: string };
  "model.fallback": { from: string; to: string; reason: string };
  compare: { summary: string };
  "answer.token": { text: string };
  done: { exchangeId: string; sessionId: string };
  error: { message: string; step: string };
};

export type Emit = <K extends keyof AgentEvents>(event: K, data: AgentEvents[K]) => void;
