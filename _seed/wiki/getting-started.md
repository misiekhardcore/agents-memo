---
type: meta
title: Getting Started
created: 2026-05-02
updated: 2026-05-02
tags:
  - meta
  - onboarding
status: evergreen
related:
  - [[index]]
  - [[hot]]
---
# Getting Started with agents-memo

Welcome. This vault is your compounding knowledge base — a persistent second brain built with an Obsidian vault and an AI coding agent.

Every source you add gets processed into 8–15 cross-referenced wiki pages. Every question you ask pulls from everything that's been ingested. Knowledge compounds like interest.

## How it works — data flow

Open **[[getting-started.canvas|the data-flow canvas]]** for the visual map of how sources, processing, the wiki, and retrieval connect.

The canvas shows you (yellow) interacting through capture surfaces (yellow) that land in verbatim inboxes (green). Processing skills turn inboxes into structured wiki pages. The wiki (blue/green) feeds retrieval — both explicit queries and the auto-loaded hot cache at session start. Maintenance (purple) runs on a cadence (manual or cron) and writes back into the wiki.

## Three-Step Quick Start

### 1. Drop a source

Put any document into the `.raw/` folder:

- PDFs, markdown files, transcripts, articles
- Or paste a URL and ask your agent to fetch it

### 2. Ingest it

Tell your agent in any session:

```text
ingest [filename]
```

your agent reads the source, creates 8–15 wiki pages under `wiki/`, cross-references everything, and updates `wiki/index.md`, `wiki/log.md`, and `wiki/hot.md`.

### 3. Ask questions

```text
what do you know about [topic]?
```

your agent reads the hot cache, scans the index, drills into relevant pages, and gives you a synthesized answer — citing specific wiki pages, not training data.

## How the Hot Cache Works

`wiki/hot.md` is a ~500-word summary of recent vault context. It loads automatically at the start of every session (via the SessionStart hook).

You don't need to recap. your agent starts every session knowing what you've been working on.

Update it manually at any time: `update hot cache`

## Your First Ingest — Walkthrough

1. Create a file in `.raw/` — copy a transcript, paste an article, or save a PDF
2. Open pi in this vault folder
3. Type: `/memo-ingest [your-filename]`
4. Watch the wiki grow — the agent will report which pages it created
5. Open `wiki/index.md` — you'll see the new pages listed
6. Open Graph View in Obsidian — a new cluster of connected nodes appears

After 3–5 ingests, the graph starts to look like a real knowledge network. Cross-references emerge automatically.

## Key Commands

|You say|Your agent does|
|-|-|
|`/memo-ingest [file]`|Creates 8–15 wiki pages from a source|
|`what do you know about X?`|Queries the wiki, cites pages|
|`/memo-save`|Files this conversation as a wiki note|
|`/memo-autoresearch [topic]`|Searches the web, ingests results autonomously|
|`lint the wiki`|Health check — finds orphans, gaps, stale links|
|`update hot cache`|Refreshes the session context summary|

## Next Steps

- Open **[[index]]** for the master catalog of every page in your vault.
- Read **[[hot]]** to see what context your agent is currently carrying into sessions.
- Drop your first source into `.raw/` and run an ingest.

_Built on the LLM Wiki pattern by Andrej Karpathy: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f_
