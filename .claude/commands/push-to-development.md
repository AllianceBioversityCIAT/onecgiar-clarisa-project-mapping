---
description: Push master to origin, open origin master→development PR, and merge it
allowed-tools: Bash
---

You are running the **push to development** flow for PRMS Projects Registry.

## What this command does

1. Pushes local `master` to `origin/master` (CodeObia).
2. Opens a pull request on the origin repo from `master` → `development`.
3. Merges that PR using a **merge commit** (preserves individual commit history on `development`).

Origin repo: `CodeObia/PRMS-Projects-Registry`

## Preflight checks

Run in parallel and report what you find:

- `git rev-parse --abbrev-ref HEAD` — must be `master`. Abort if not.
- `git status --porcelain` — tracked-but-uncommitted changes abort the flow; untracked files (`??` lines) are fine and should be ignored.
- `git fetch origin master development` then `git rev-list --count origin/master..master` and `git rev-list --count origin/development..master`.

If the branch is not `master`, STOP and tell the user.

If there are tracked modifications that aren't committed, STOP and surface them.

If there are zero commits ahead of `origin/development`, tell the user there's nothing to deploy and STOP.

## Execution

Run sequentially (each step must succeed before the next):

1. `git push origin master`
2. Open the PR:
   ```
   gh pr create \
     --repo CodeObia/PRMS-Projects-Registry \
     --base development --head master \
     --title "Deploy master to development — $(date +%Y-%m-%d)" \
     --body "$(cat <<'EOF'
   ## Summary
   Development deploy from `master`.

   See commit list below for the changes included.

   ## Test plan
   - [ ] Verify on development environment after merge
   EOF
   )"
   ```
   Capture the returned PR URL — you'll need its number for the merge step.

3. Merge it:
   ```
   gh pr merge <PR_NUMBER> \
     --repo CodeObia/PRMS-Projects-Registry \
     --merge
   ```
   (Use `--merge` for a merge commit, NOT `--squash` or `--rebase`.)

## Reporting

After the merge succeeds, report:
- Number of commits pushed to `origin/master`
- PR URL
- Merge commit SHA on `origin/development` (from `gh pr view <PR_NUMBER> --json mergeCommit --repo …`)

If any step fails, stop immediately and surface the error verbatim — do not retry or work around it.
