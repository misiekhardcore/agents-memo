# agents-memo demo recording

Re-recordable demo assets for the README (#8): a 3-scene video showing
ingest → query → save against a scratch Obsidian vault.

## Layout

|Path|What|In git?|
|-|-|-|
|`ingest.tape` `query.tape` `save.tape`|vhs scene tapes (deterministic keystrokes)|yes|
|`setup.sh`|rebuilds `runtime/` (seed vault + isolated pi config)|yes|
|`README.md`|this file|yes|
|`runtime/`|throwaway env — seeded vault, pi config (contains a copy of `~/.pi/agent/auth.json`!), project dir, scene recordings|**no** (gitignored)|

## Prerequisites

- `vhs` + `ttyd` + a mono font — see `~/.pi/agent/skills/terminal-gif-recording/SKILL.md`
- Obsidian running with the demo vault open: `runtime/vault` (Open another
  vault → Open folder as vault). The CLI targets the vault by name
  (`vault=<basename>`), so any window focus works.
- agents-memo registered as a pi package (it is, from this workspace).

## Rebuild + record

```bash
demo/setup.sh                       # wipes + rebuilds runtime/
# open runtime/vault in Obsidian, then:
cd demo/runtime/scenes
vhs-record.sh ../../ingest.tape     # ~15 min (real agent run + render)
vhs-record.sh ../../query.tape      # ~15 min
vhs-record.sh ../../save.tape       # ~15 min
```

Each tape runs a fresh pi session (`PI_CODING_AGENT_DIR=<runtime>/config`, real
HOME) so the real vault is never touched. Scenes must be recorded in order on
one runtime (query and save read the pages ingest created) — never re-run
`setup.sh` between scenes, only before scene 1.

## Prompts embed the demo contract

Each prompt tells the agent to: work inline (no sub-agents), not read plugin
source, create pages against the (pristine) vault, and commit with `git add
wiki/ .raw/` only — never `.obsidian`. If a take shows the agent saying "no
new pages / already exists", the vault wasn't pristine: re-run `setup.sh` and
re-open the vault in Obsidian.

## Known constraints

- Takes are non-deterministic (real LLM runs). A bad take = delete the scene
  mp4 and re-record that scene (scene 1 needs a `setup.sh` re-run first).
- Recording wall-clock ≈ the LLM run + vhs render (~15 min/scene); playback
  speed is set in the tape (`Set PlaybackSpeed 8`).
- After editing, the final cut lives at repo `assets/demo.mp4` and is embedded
  in the README via `<video>`.
