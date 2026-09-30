# AGENTS — fps-camcontrol

AI coding workflow is active for this repo. Canonical context lives in `docs/ai/`:

- `docs/ai/project-state.md` — current working state
- `docs/ai/repo-map.md` — where things live
- `docs/ai/architecture.md` — how it fits together
- `docs/ai/testing-guide.md` — how to verify
- `docs/ai/current-plan.md` — active plan
- `docs/ai/decisions.md` — decision log

Read these before planning or editing. Keep them current via the project-state-updater step.

## Worktree hygiene
Once a branch's work is committed and pushed to a PR, remove its worktree immediately (`git worktree remove <path> && git worktree prune`) and squash-delete the local branch. Never leave worktrees checked out after PR creation; idle worktrees keep compiling, watching, and eating disk. One active worktree per task, gone when the PR opens.
