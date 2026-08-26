---
name: memo-research-program
description: Research program specification — search objectives, confidence scoring, constraints, style, source trust.
user-invocable: false
---
# Research Program Specification

Standard configuration for the `memo-autoresearch` loop. Read before every run.

## Search Objectives
- Find authoritative sources (prefer .edu, peer-reviewed, official docs, primary sources).
- Extract key entities, concepts, and frameworks.
- Note contradictions and identify research gaps.
- Favor sources from the last 2 years unless the topic is foundational.

## Confidence Scoring
|Level|Criteria|
|-|-|
|**high**|Multiple independent authoritative sources agree.|
|**medium**|Single good source, or partial agreement.|
|**low**|Speculation, opinion pieces, or unverified claims.|
- Mark claims >3 years old as potentially stale.

## Constraints & Limits
- **Rounds**: Max 3 search rounds per topic.
- **Volume**: Max 15 wiki pages created per session; max 5 sources fetched per round.
- **Overflow**: If page limit is hit, file existing work and list remaining gaps in `Open Questions`.

## Style & Quality
- **Format**: Declarative, present tense. No hedging ("perhaps", "seems").
- **Citations**: Every non-obvious claim must be cited: `(Source: [[Page]])`.
- **Sizing**: Pages < 200 lines. Split if longer.
- **Uncertainty**: Use `> [!gap] This claim needs verification.`

## Source Trust
- **High Confidence**: Official docs, Academic papers.
- **Low Confidence**: Reddit, forums, social media, undated pages (use as pointers only).
