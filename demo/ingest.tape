# Scene 1 — ingest (record from demo/runtime/scenes: vhs-record.sh ../../ingest.tape)
Output ingest.mp4
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 14
Set Width 920
Set Height 660
Set Padding 12
Set PlaybackSpeed 8

Type "cd /home/michal/Projects/agents-memo/.forge/worktrees/ws-908eb366/demo/runtime/project"
Enter
Sleep 1s
Type "PI_OFFLINE=1 PI_CODING_AGENT_DIR=/home/michal/Projects/agents-memo/.forge/worktrees/ws-908eb366/demo/runtime/config pi"
Enter
Sleep 12s
Type "ingest https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/401 — compact auto-ingest: do it INLINE yourself, do NOT dispatch sub-agents. Create ONE source page and ONE concept page with brief content, update wiki/index.md and wiki/log.md minimally. The vault is configured and works — do NOT read plugin source files or docs. When done, commit the vault changes with git: stage only wiki/ and .raw/ (never .obsidian) and use a descriptive message."
Enter
Sleep 480s
Ctrl+D
Sleep 30s
Type "exit"
Enter
