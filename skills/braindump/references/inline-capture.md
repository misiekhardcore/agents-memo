# Inline CAPTURE (Sequential)

For each chunk in order, re-enumerate `<vault_root>/notes/*.md` fresh (so chunk K can MATCH-append to a note written by chunk K-1). Then:

1. MATCH/NEW per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §4 — skip `notes/index.md` and `status: deferred`; cap at 20 most recent.
2. MATCH or NEW path per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §4; slug via `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §3.
3. Index patch per `${MEMO_PLUGIN_PWD}/skills/capture-pipeline/SKILL.md` §6.
4. Record filename + success/failure. On error: append to failure list, continue — never abort the loop.
