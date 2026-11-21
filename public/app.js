// Minimal chat client: sessions sidebar, SSE over fetch, a live step timeline, and a small
// markdown renderer that understands the server's two markups: [n] citations and verified <q> quotes.

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const input = $("#input");
const sendBtn = $("#send");

let currentSession = null;
let busy = false;

const api = (url, opts = {}) => fetch(url, { ...opts, headers: { "x-timezone": TZ, ...(opts.headers || {}) } });

// ── Sessions ───────────────────────────────────────────────────────────────

async function loadSessions() {
  const sessions = await (await api("/api/sessions")).json();
  const nav = $("#sessions");
  nav.innerHTML = "";
  for (const s of sessions) {
    const a = document.createElement("a");
    a.href = `#${s.id}`;
    a.className = s.id === currentSession ? "active" : "";
    a.innerHTML = `${esc(s.title)}<small>${fmtDate(s.lastAt)}</small>`;
    a.onclick = (e) => {
      e.preventDefault();
      if (!busy) openSession(s.id);
    };
    nav.append(a);
  }
  $("#seed-hint").hidden = sessions.length > 0;
}

async function openSession(id) {
  const res = await api(`/api/sessions/${id}`);
  if (!res.ok) return newChat();
  const { exchanges } = await res.json();
  currentSession = id;
  history.replaceState(null, "", `#${id}`);
  messagesEl.innerHTML = "";
  for (const e of exchanges) {
    addUser(e.userText, e.userSentAt);
    const el = addAssistant();
    if (e.status === "complete") renderBody(el, e.assistantText);
    else {
      el.classList.add("failed");
      el.querySelector(".body").textContent = e.status === "failed" ? "No reply: this turn failed." : "…still answering";
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  loadSessions();
}

function newChat() {
  currentSession = null;
  history.replaceState(null, "", location.pathname);
  messagesEl.innerHTML = "";
  messagesEl.append(emptyState);
  loadSessions();
  input.focus();
}

// ── Sending a message (SSE over fetch) ─────────────────────────────────────

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;
  emptyState.remove();
  addUser(text, new Date().toISOString());
  const el = addAssistant();
  const steps = new Timeline(el.querySelector(".steps"));
  const sources = new Map(); // n → {title, url}, filled live from web.result
  let answer = "";
  const started = Date.now();

  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: currentSession, message: text }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    for await (const { event, data } of readSSE(res.body)) {
      switch (event) {
        case "session":
          currentSession = data.sessionId;
          history.replaceState(null, "", `#${data.sessionId}`);
          if (data.isNew) loadSessions();
          break;
        case "plan":
          for (const q of data.questions) steps.add(`${data.questions.length > 1 ? `${q.queryId} · ` : ""}${q.summary}`, "");
          break;
        case "memory.search":
          steps.add(`Searching your chats · ${data.searched}`, "memory pending", `mem-${data.queryId}`);
          break;
        case "memory.found":
          steps.update(
            `mem-${data.queryId}`,
            data.all ? `All ${data.memories} memories` : `${data.memories} memor${data.memories === 1 ? "y" : "ies"} from ${data.sessions.map((s) => `${s.title} (${s.date})`).join(", ")}`,
            "memory",
          );
          break;
        case "memory.none_on_date":
          steps.update(
            `mem-${data.queryId}`,
            `Nothing on ${data.date}${data.nearestElsewhere ? ` · nearest elsewhere: “${data.nearestElsewhere.title}” (${data.nearestElsewhere.date})` : ""}`,
            "memory",
          );
          break;
        case "memory.none":
          steps.update(`mem-${data.queryId}`, `No matching chat · searched ${data.searched}`, "memory");
          break;
        case "history.read":
          steps.add(
            data.what === "chats"
              ? `Reading past chat${data.items.length === 1 ? "" : "s"}: ${data.items.map((i) => `${i.title} (${i.date})`).join(", ")}`
              : `Reading what I found back then: ${data.items.map((i) => `${i.title} (${i.date})`).join(", ")}`,
            "memory",
          );
          break;
        case "web.search":
          steps.add(`Searching: ${data.query}`, "web pending", `web-${data.query}`);
          break;
        case "web.result":
          for (const s of data.sources) sources.set(s.n, s);
          steps.update(
            `web-${data.query}`,
            data.error ? `Search failed: ${data.query} (${data.error})` : `Read ${data.sources.length} results for “${data.query}”: ${[...new Set(data.sources.map((s) => host(s.url)))].slice(0, 4).join(", ")}`,
            data.error ? "error" : "web",
          );
          break;
        case "model.fallback":
          steps.add(`${data.from.replace(/^\w+:/, "")} is busy · answering with ${data.to.replace(/^\w+:/, "")}`, "");
          break;
        case "compare":
          steps.add(data.summary, "");
          break;
        case "answer.token":
          answer += data.text;
          renderBody(el, answer, sources);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case "error":
          steps.add(`Error during ${data.step}: ${data.message}`, "error");
          break;
        case "done":
          steps.collapse(`${steps.count} steps · ${((Date.now() - started) / 1000).toFixed(1)}s`);
          loadSessions();
          break;
      }
    }
  } catch (err) {
    steps.add(`Connection error: ${err.message}`, "error");
  } finally {
    steps.settle();
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
    }
  }
}

class Timeline {
  constructor(details) {
    this.details = details;
    this.list = details.querySelector("ol");
    this.byKey = new Map();
    this.count = 0;
    details.hidden = false;
  }
  add(text, cls, key) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = text;
    this.list.append(li);
    this.count++;
    if (key) this.byKey.set(key, li);
    this.details.querySelector("summary").textContent = "Working…";
  }
  update(key, text, cls) {
    const li = this.byKey.get(key);
    if (!li) return this.add(text, cls);
    li.textContent = text;
    li.className = cls;
  }
  collapse(summary) {
    this.details.open = false;
    this.details.querySelector("summary").textContent = summary;
  }
  settle() {
    for (const li of this.list.querySelectorAll(".pending")) li.classList.remove("pending");
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function addUser(text, at) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="bubble" title="${esc(fmtDate(at))}"></div>`;
  div.querySelector(".bubble").textContent = text;
  messagesEl.append(div);
}

function addAssistant() {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<details class="steps" open hidden><summary>Working…</summary><ol></ol></details><div class="body"></div>`;
  messagesEl.append(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

/** Renders an answer: body markdown + [n] citations + verified quotes, and the Sources footer. */
function renderBody(el, text, liveSources = new Map()) {
  const split = text.lastIndexOf("\n\nSources:\n");
  const body = split >= 0 ? text.slice(0, split) : text;
  const sources = new Map(liveSources);
  if (split >= 0) {
    for (const line of text.slice(split + 11).split("\n")) {
      const m = /^\[(\d+)\] (.*) — (\S+)$/.exec(line.trim());
      if (m) sources.set(Number(m[1]), { title: m[2], url: m[3] });
    }
  }
  let html = markdown(body, sources);
  if (split >= 0 && sources.size) {
    const cited = [...sources.entries()].filter(([n]) => new RegExp(`\\[${n}\\]`).test(body)).sort((a, b) => a[0] - b[0]);
    html += `<div class="sources">Sources<ol>${cited.map(([n, s]) => `<li value="${n}"><a href="${attr(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span>${esc(host(s.url))}</span></li>`).join("")}</ol></div>`;
  }
  el.querySelector(".body").innerHTML = html;
}

function markdown(src, sources) {
  // Verified quotes become placeholders before escaping and go back in last,
  // so no markdown rule ever runs over their attributes.
  const quotes = [];
  src = src.replace(/<q ex="([^"]*)" side="(user|assistant)" at="([^"]*)">([\s\S]*?)<\/q>/g, (_, ex, side, at, inner) => {
    quotes.push({ side, at, inner });
    return `\u0000${quotes.length - 1}\u0000`;
  });
  const html = inline(esc(src).split(/\n{2,}/).map((b) => block(b)).join(""), sources);
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const q = quotes[Number(i)];
    const who = q.side === "user" ? "you" : "me";
    return `<span class="quote" title="Checked against ${q.side === "user" ? "your" : "my"} message of ${esc(q.at)}"><span class="qt">${esc(q.inner)}</span><span class="who">${who}, ${esc(q.at)}</span></span>`;
  });

  function block(b) {
    const lines = b.split("\n");
    if (b.startsWith("```")) return `<pre><code>${b.replace(/^```\w*\n?|```$/g, "")}</code></pre>`;
    if (lines.length >= 2 && /^\s*\|/.test(lines[0]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(lines[0]).map((c) => `<th>${c}</th>`).join("");
      const rows = lines.slice(2).map((l) => `<tr>${cells(l).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    // Runs of list lines, headings and text inside one block ("Summary:\n- a\n- b").
    let out = "";
    let run = [];
    let type = null;
    const flush = () => {
      if (!run.length) return;
      if (type === "list") {
        const items = run.map((l) => `<li>${l.replace(/^\s*([-*•]|\d+\.)\s/, "")}</li>`).join("");
        out += /^\s*\d+\./.test(run[0]) ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      } else if (type === "h") out += `<h4>${run[0].replace(/^#{1,6}\s/, "")}</h4>`;
      else out += `<p>${run.join("<br>")}</p>`;
      run = [];
    };
    for (const l of lines) {
      const t = /^\s*([-*•]|\d+\.)\s/.test(l) ? "list" : /^#{1,6}\s/.test(l) ? "h" : "text";
      if (t !== type || t === "h") flush();
      type = t;
      run.push(l);
    }
    flush();
    return out;
  }
}

/** Bold, code, links and [n] citations, applied only to text between tags (never inside an attribute). */
function inline(html, sources) {
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith("<")
        ? part
        : part
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/\[(\d+)\]/g, (m, n) => {
              const s = sources.get(Number(n));
              return s ? `<sup class="cite"><a href="${attr(s.url)}" target="_blank" rel="noopener" title="${attr(s.title)}">${n}</a></sup>` : `<sup class="cite">${n}</sup>`;
            }),
    )
    .join("");
}

// ── Utils ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
const attr = esc;
function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ── Wiring ─────────────────────────────────────────────────────────────────

const emptyState = $("#empty");
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  input.style.height = "";
  send(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "";
  input.style.height = `${input.scrollHeight}px`;
});
$("#new-chat").onclick = () => !busy && newChat();
for (const b of emptyState.querySelectorAll(".examples button")) b.onclick = () => send(b.textContent);

if (location.hash.length > 1) openSession(location.hash.slice(1));
else newChat();
