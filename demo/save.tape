# Scene 3 — save + commit coda (record from demo/runtime/scenes: vhs-record.sh ../../save.tape)
Output save.mp4
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 14
Set Width 920
Set Height 660
Set Padding 12
Set Framerate 15
Set PlaybackSpeed 8

Type "cd /home/michal/Projects/agents-memo/.forge/worktrees/ws-908eb366/demo/runtime/project"
Enter
Sleep 1s
Type "PI_OFFLINE=1 PI_CODING_AGENT_DIR=/home/michal/Projects/agents-memo/.forge/worktrees/ws-908eb366/demo/runtime/config pi --tui-mode fullscreen"
Enter
Sleep 12s
Type "/memo-save this insight: HTTP 401 means the client is unauthenticated — retry with credentials via the WWW-Authenticate scheme (Bearer/Basic). HTTP 403 means the client is authenticated but lacks permission. Never conflate the two. The vault is configured and works — do NOT read plugin source files or docs. When done, commit the vault changes with git: stage only wiki/ and .raw/ (never .obsidian) and use a descriptive message."
Enter
Sleep 600s
Ctrl+D
Sleep 30s
Type "git -C /home/michal/Projects/agents-memo/.forge/worktrees/ws-908eb366/demo/runtime/vault log --oneline -5"
Enter
Sleep 5s
Type "exit"
Enter
