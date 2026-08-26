# Response Formatting

## Synthesis Format

Synthesize the answer in chat. Cite sources with wikilinks: `(Source: [[Page Name]])`.

After answering, offer to file: "This analysis seems worth keeping. Should I save it as `wiki/questions/answer-name.md`?"

## Filing Answers Back

Good answers compound into the wiki. Use `/memo-save` to file the answer as a wiki page when it contains reusable knowledge.

When filing an answer:

```yaml
---
type: question
title: "Short descriptive title"
question: "The exact query as asked."
answer_quality: solid
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [question, <domain>]
related:
  - "[[Page referenced in answer]]"
sources:
  - "[[wiki/sources/relevant-source.md]]"
status: developing
---
```

Then write the answer as the page body. Include citations. Link every mentioned concept or entity.

After filing, add an entry to `wiki/index.md` under Questions and append to `wiki/log.md`.

## Deep Mode Filing

Deep answers are too valuable to lose. Always file the result as a wiki page after deep mode synthesis.
