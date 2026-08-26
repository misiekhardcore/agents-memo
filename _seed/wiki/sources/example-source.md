---
type: source
title: Example Source
source_type: article
author: 
date_published: {{today}}
url: 
source_reliability: high
key_claims:
  - Source pages capture what was found in a document, not inferences from it
  - Each source gets its own page, linked from any concept or entity it informs
created: {{today}}
updated: {{today}}
tags:
  - source
  - example
status: seed
confidence: EXTRACTED
evidence: []
related:
  - [[example-concept]]
  - [[example-entity]]
  - [[example-question]]
---
# Example Source

## Summary

A source page is the ingest record for a single document. It holds the document's metadata, a summary, and the key claims extracted from it. Downstream concept and entity pages link back here as their evidence.

## Key Claims

- Source pages use `confidence: EXTRACTED` because they summarize what is directly in the document
- The `key_claims` frontmatter field holds the most important findings as a flat list
- `source_reliability` captures how trustworthy the source itself is (high / medium / low)

## Entities Mentioned

- [[example-entity]] — illustrates how entities are linked from source pages

## Concepts Introduced

- [[example-concept]] — illustrates how concepts are linked from source pages

## Notes

Replace this page with a real source by running `/memo-wiki ingest` on a document.
