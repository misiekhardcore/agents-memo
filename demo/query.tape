# Scene 2 — query (record from demo/runtime/scenes: vhs-record.sh ../../query.tape)
Output query.mp4
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
Type "query: what HTTP status signals an authentication failure, and how is it different from a permissions problem? When done, commit the vault changes with git: stage only wiki/ and .raw/ (never .obsidian) and use a descriptive message."
Enter
Sleep 600s
Ctrl+D
Sleep 30s
Type "exit"
Enter
