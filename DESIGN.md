# Design

This is a chat agent that can search the web and remembers every conversation you've had with it.

The agent answers from memories. A memory is one short, dated line about something *you* said: a fact about yourself, a decision you made, or a question you asked. Each memory points back to the message it came from, so the agent can fetch the full conversation whenever it needs more detail.

![Architecture](docs/architecture.png)

Your message goes through the purple boxes in order, the Planner, the Retriever and then the Answerer, all within one request. Once you have your reply, the Memory writer runs in the background.

## Models

Everything runs on Anthropic's Claude, and `.env.example` lists only Claude models.

- **Claude Sonnet 5.5** writes the answers. That's the hardest job, so it gets the stronger model. It works from short memories, so its prompts stay small.
- **Claude Haiku 5.5** does the two lighter jobs:
  1. **Planner** - splits each message into separate questions and decides which ones need past chats.
  2. **Memory Writer** - after the reply has gone out, writes down what you said in that message: facts about you, decisions you made, and what you asked, each dated and checked against your own words.

EmbeddingGemma, running inside the Node process, turns messages and memories into vectors so the Retriever can search them by meaning.

## Components

### Chat UI
[`public/`](public/) · [`src/server.ts`](src/server.ts)

A plain web page served by a small Node server. The server saves your message to the database first, so it's kept even if a later step fails, and then passes it to the **Planner**.

### Planner
[`src/planner.ts`](src/planner.ts) · [`src/timeResolver.ts`](src/timeResolver.ts)

**Input:** your message and timezone, plus the last ten turns of the current chat, so it knows what you're talking about.

**How it works:** Haiku, a small and fast model, splits your message into separate questions. For each one it decides whether it needs your past chats. If it does, it writes a short search query and a few keywords that the Retriever can use to fetch chats about that topic from the database. It also copies out any time phrase, like "last Tuesday", which code turns into exact dates.

Broad questions get the whole memory instead of a search. There are three kinds: questions about you ("what do you know about me?"), picks that depend on your tastes ("what should I order tonight?"), and questions whose subject could mean two things ("what's on the shortlist?" when you have two lists). Small talk like "hi" needs no past chats, so it goes straight to the Answerer.

**Output:** the questions, with their search queries, keywords and time phrases, go to the **Retriever**. The **Answerer** decides on its own when to search the web.

### Retriever
[`src/retriever.ts`](src/retriever.ts)

**Input:** the questions from the **Planner** that need past chats, each with its search query, keywords, date window, whose words to look at, and whether it's broad.

**How it works:** The Retriever uses each part of the Planner's output to build database queries. It also turns the search query into a vector, so it can search by meaning as well as by keyword.

1. **It searches two tables, two ways.** The keywords go to Postgres full-text search, and the query vector goes to pgvector. Both search the saved messages and replies, and the memories. Your original message is searched the same way, in case the Planner's query left something out.
2. **"Whose words" picks the side.** For "what did *I* say on Tuesday", the date filter checks when you sent the message, and matches in your messages rank higher. For "what did *you* tell me", it checks the agent's reply. For a question about how things stand now, newer chats rank a little higher.
3. **There's a relevance bar.** A match has to be close in meaning or contain most of the keywords to count.
4. **It hands over memories.** Each match leads to its chat, and the Retriever fetches all of that chat's memories. With an exact date, it fetches only the memories of the matched messages, so other days stay out. A match with no memories gives nothing. There's no cap, since memories are small.

Two kinds of question skip the search. For a broad one, it fetches every memory you have. For one that names only a date ("what did I ask on 3 Nov?"), it fetches the memories from that day's messages. If nothing happened on the date asked about, it says so and fetches the memories of the closest chat from another day, marked as another day.

**Output:** the memories for each question, with a short note on what was searched, go to the **Answerer**. The matched messages go to the **Memory writer** after the reply, as context for that turn.

### Answerer
[`src/answerer.ts`](src/answerer.ts) · [`src/promptBuilder.ts`](src/promptBuilder.ts) · [`src/quoteVerifier.ts`](src/quoteVerifier.ts)

**Input:** the current chat in full, plus the memories and notes from the **Retriever**.

**How it works:** Sonnet reads the memories oldest first, and its prompt tells it that a newer memory replaces an older one on the same subject. When it needs more than the memories, it has three tools:
1. **Web search**, through Exa, for anything current. It runs independent searches in parallel and takes as many rounds as it needs, up to a high backstop.
2. **Past chats** fetches the full conversations behind the memories it picks, several at once, so it can see what it recommended back then or exactly how you put something.
3. **Past web results** fetches what it found on the web back then: its answer and the passages it cited, word for word, with the page, when it read it and the search that found it.

The last two open only the chats behind memories the Retriever sent. For "has anything changed?", it uses past web results and a fresh search together, and compares three things for each item: what the page said back then, what it told you back then, and what the page says now. That way it can tell "the price went up" apart from "I got it wrong the first time".

**Output:** the answer streams to the **Chat UI**. The reply and the passages it cited are saved to the **database** right away, so the Retriever can find them for your next message. The turn then goes into the queue for the **Memory writer**.

### Memory writer
[`src/memoryWriter.ts`](src/memoryWriter.ts)

**Input:** a finished turn from the queue, with the earlier messages of that chat, the past messages the **Retriever** matched, and the existing memories closest to it.

**How it works:** Haiku writes down only what *you* said. A memory is one of three things:
- a fact or need about you ("The user's favourite food is pasta.", "The user wants a CRM for their 20-person sales team."), including ones you mention in passing while asking about something else;
- a decision, written out in full with its date ("On Wed 18 Nov 2026 the user replaced Close with Salesforce Starter, so the shortlist became…");
- a request: what you asked, and when ("On Tue 3 Nov 2026 the user asked what Notion's Plus plan costs"). These let the agent answer "what did I ask on 3 November?".


Jobs run one at a time and retry when they fail. Anything missed because of a crash or an outage is redone the next time the server starts.

**Output:** memories, each linked to the message it came from, saved to the **database**, where the **Retriever** finds them for later messages.

### Database
[`src/db.ts`](src/db.ts) · [`src/exchangeStore.ts`](src/exchangeStore.ts)

We have a real Postgres running inside the Node process. pgvector handles search by meaning, and Postgres full-text search handles keywords. 

Six tables:
- **users**: one row per browser, identified by a cookie, with its timezone.
- **sessions**: one row per chat, with its title and when it started.
- **exchanges**: one row per message and its reply, word for word, with when each was sent, plus a vector and a keyword index for search.
- **observations**: the page passages each reply cited, saved exactly as they read at the time. They're the "back then" in "has it changed since?".
- **memories**: the Memory writer's notes, each pointing to the exchange it came from, with its own vector and keyword index.
- **meta**: which embedding model made the stored vectors. Switch models and everything is re-embedded once at startup, since vectors from two models can't be compared.

## What was rejected

- **Sending the full chats those memories came from with every message.** Most questions need only the memories. The Answerer decides on its own when it needs more, and then opens the full chats behind the memories and the web results it found back then.

## What will I add next

- **Links between memories**, like Supermemory, which connects related memories into a graph. A decision could then point to the one it replaced.
- **Updating and deleting memories**, so a wrong or outdated memory can be fixed or removed.
