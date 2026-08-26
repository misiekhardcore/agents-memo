---
type: meta
title: Hot Cache
created: {{today}}
updated: {{today}}
tags:
  - meta
  - hot
status: evergreen
confidence: EXTRACTED
evidence: []
related:
  - [[index]]
  - [[log]]
  - [[overview]]
---
# Recent Context

> **Demo content** — this file is overwritten at the end of every wiki operation. It shows what a populated hot cache looks like. Delete this notice once your first real ingest has run and replaced this content.

## Last Updated

{{today}}. Vault initialized with starter pages via `/memo-wiki init`.

## Key Recent Facts

This vault uses a four-layer wiki schema: **sources** capture what documents say, **entities** record named real-world things, **concepts** synthesize patterns across sources, and **questions** track open and answered queries. All pages carry `confidence:` (EXTRACTED | INFERRED | AMBIGUOUS) and an `evidence:` list so claims can be traced to their origin.

The **hot cache** (this file) is the cheapest entry point for any session — it answers "what happened recently?" without opening the full index. Claude reads it silently at session start. Keep it under 500 words and overwrite it completely after every operation.

The **index** ([[index]]) is the master catalog; the **log** ([[log]]) is the chronological record of operations; **overview** ([[overview]]) is the executive summary of what this vault covers.

## Recent Changes

- Created: [[example-concept]] — concept stub demonstrating the schema
- Created: [[example-entity]] — entity stub demonstrating typed relationships
- Created: [[example-source]] — source stub with key_claims and reliability rating
- Created: [[example-question]] — question stub with answer_quality field
- Created: [[index]], [[log]], [[overview]] — structural meta pages
- Created: FIRST_RUN.md — onboarding guide at vault root

## Active Threads

- Vault is freshly initialized; no research threads yet
- Next step: run `/memo-wiki ingest <path-or-url>` to add your first real source
- Example pages are placeholders — delete them once you've ingested real content

## Schema Quick Reference

|Page type|Directory|confidence default|evidence required?|
|-|-|-|-|
|source|wiki/sources/|EXTRACTED|No|
|concept|wiki/concepts/|INFERRED|Yes|
|entity|wiki/entities/|INFERRED|Yes|
|question|wiki/questions/|INFERRED|Yes|
|meta|wiki/|EXTRACTED|No|
