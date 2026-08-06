# Autoresearch: Research Loop & Filing Instructions

## Research Loop

```text
Input: topic (from user command)

Round 1. Broad search — INLINE (main thread)
1. Decompose topic into 3-5 distinct search angles
2. For each angle: run 2-3 WebSearch queries
3. For top 2-3 results per angle: WebFetch the page
4. Extract from each: key claims, entities, concepts, open questions
5. Dispatch one agents/memory-source-synth.md per fetched source IN PARALLEL.
   Pass seed-brief: SOURCE_CONTENT, SOURCE_URL, RAW_PATH, VAULT_ROOT, TODAY, RESEARCH_TOPIC.
   Wait for all source-synth agents to finish. Collect their reports.

Round 2. Gap fill — PARALLEL AGENT FAN-OUT
5. Identify what's missing or contradicted from Round 1
6. For each gap, dispatch one agents/memory-research-round.md IN PARALLEL.
   Pass seed-brief: GAP, RESEARCH_TOPIC, EXISTING_SOURCES (URLs fetched in Round 1),
         MAX_QUERIES=5, MAX_FETCHES=3, VAULT_ROOT, TODAY.
   Wait for all research-round agents to finish. Collect their reports.

Round 3. Synthesis check — SINGLE AGENT DISPATCH (optional, if gaps remain)
7. If major contradictions or missing pieces still exist: dispatch one
   agents/memory-research-round.md for the remaining gap.
8. Otherwise: proceed to filing

Max rounds: 3 (as set in program.md). Stop when depth is reached or max rounds hit.
```

The seed-brief contract: orchestrator provides all context as explicit input variables. Agents do not re-research what's already provided in the brief.

## Filing Results

After research is complete, create these pages:

**wiki/sources/**. One page per major reference found

- Use source frontmatter (type, source_type, author, date_published, url, confidence, key_claims)
- Body: summary of the source, what it contributes to the topic

**wiki/concepts/**. One page per significant concept extracted

- Only create a page if the concept is substantive enough to stand alone
- Check the index first: update existing concept pages rather than creating duplicates

**wiki/entities/**. One page per significant person, org, or product identified

- Check the index first: update existing entity pages

**wiki/questions/**. One synthesis page titled "Research: [Topic]"

- This is the master synthesis. Everything comes together here.
- Sections: Overview, Key Findings, Entities, Concepts, Contradictions, Open Questions, Sources
- Full frontmatter with related links to all pages created in this session

**wiki/trails/**. Exactly one `type: trail` page per run, regardless of atomic-note count

- Filename: `wiki/trails/Trail: [Topic] (YYYY-MM-DD).md` (the date suffix uses the run date, so multiple runs on the same topic produce distinct files — never merge or overwrite).
- Emit immediately **after** the synthesis page is written and **before** any `## After Filing` step (index, log, hot.md). The index and log entries naturally pick the trail up from this position.
- Body is an ordered Markdown list. One step per atomic note created in this run, in argument order. Each step has exactly one `[[wikilink]]` to that atomic note plus a single LLM-synthesized one-line annotation describing the note's role in the argument (why this note next, what it contributes).
- No minimum atomic-note count. A run that produced one note still emits a one-step trail — the run-record value beats the empty-trail cost.
- Create `wiki/trails/` lazily on first emission if it does not exist.

## Page Schemas

See `references/page-schemas.md` for full synthesis and trail templates. Key rules:
- **Synthesis pages**: one `type: synthesis`, `related:` lists all created pages, sections include Overview, Key Findings, Entities, Concepts, Contradictions, Open Questions, Sources.
- **Trail pages**: one `type: trail`, `status: mature`, `confidence: EXTRACTED`, body is **exactly one** ordered list with one wikilink + annotation per item (no URLs, no extra wikilinks in annotations).
