# Rework Flow

When rework is detected, follow this protocol instead of the Greenfield Phases 1 and 3.

## Phase 1: Plan (Rework)

1. Extract the PR number from the prompt.
2. Fetch the existing PR's branch name:
   ```bash
   gh pr view <num> --json headRefName --jq '.headRefName'
   ```
   If this fails (PR not found, bad number), abort and report the error.
3. Store the branch name:
   ```
   set_flow_param(key="rework_branch", value=<branch-name>)
   ```
4. Call `create_workspace(branch: "<branch-name>")` to provision a worktree on the
   existing branch. Store the workspace path:
   ```
   set_flow_param(key="workspace", value=<path>)
   ```
5. Analyse the rework task and break it into subtasks. Note dependencies.
6. Read the issue body and extract acceptance criteria relevant to this rework.
7. Present the AC checklist and subtask plan to the user before proceeding.

## Phase 2: Loop

Same as the Greenfield Flow. Call `run_build_loop(workspace, task, plan)` for each subtask.

## Phase 3: Gate and Push (Rework)

**Do NOT call `open_pr()`.** The PR already exists — pushing updates it automatically.

0. **AC gate.** Confirm every AC is addressed before pushing.
1. Commit changes:
   ```bash
   cd <workspace>
   git add -A
   git commit -m "<commit_message>"
   ```
   Derive `commit_message` from build results in conventional commits format.
2. Rebase on latest base:
   ```bash
   git fetch origin main
   git rebase origin/main
   ```
   If rebase conflicts, resolve them or report to the user.
3. Push to the existing PR branch:
   ```bash
   git push origin <rework_branch>
   ```
   If push fails, report the error to the user.
4. Call `destroy_workspace(workspace)` to release the worktree.
5. Post a summary of what was pushed, referencing the existing PR number.
