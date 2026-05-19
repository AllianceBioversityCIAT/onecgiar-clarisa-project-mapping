---
description: Push current master to origin + CIAT, open CIAT master→main PR, and merge it
allowed-tools: Bash
---

You are running the **push to production** flow for PRMS Projects Registry.

## What this command does

1. Pushes the local `master` to `origin/master` (CodeObia, dev remote).
2. Pushes the local `master` to `ciat/master` (CIAT remote — production-facing).
3. Opens a pull request on the CIAT repo from `master` → `main`.
4. Merges that PR using a **merge commit** (preserves individual commit history on `main`).

CIAT repo: `AllianceBioversityCIAT/onecgiar-clarisa-project-mapping`

## Preflight checks

Before doing anything, run these in parallel and report what you find:

- `git rev-parse --abbrev-ref HEAD` — must be `master`. Abort if not.
- `git status --porcelain` — must be empty (no uncommitted changes). Abort if dirty.
- `git rev-list --count origin/master..master` — commits ahead of origin (will be pushed).
- `git fetch ciat main master` then `git rev-list --count ciat/master..master` and `git rev-list --count ciat/main..master` — commits ahead of CIAT master and CIAT main.

If the branch is not `master` or the working tree is dirty, STOP and tell the user — do not push.

If there are zero commits ahead of `ciat/main`, tell the user there's nothing to deploy and STOP.

## Execution

Run sequentially (each step must succeed before the next):

1. `git push origin master`
2. `git push ciat master`
3. Open the PR:
   ```
   gh pr create \
     --repo AllianceBioversityCIAT/onecgiar-clarisa-project-mapping \
     --base main --head master \
     --title "Deploy master to main — $(date +%Y-%m-%d)" \
     --body "$(cat <<'EOF'
   ## Summary
   Production deploy from `master`.

   See commit list below for the changes included.

   ## Test plan
   - [ ] Smoke-test on prod after merge
   EOF
   )"
   ```
   Capture the returned PR URL — you'll need its number for the merge step.

4. Merge it:
   ```
   gh pr merge <PR_NUMBER> \
     --repo AllianceBioversityCIAT/onecgiar-clarisa-project-mapping \
     --merge
   ```
   (Use `--merge` for a merge commit, NOT `--squash` or `--rebase`.)

## Reporting

After the merge succeeds, report:
- Number of commits pushed to `origin/master` and `ciat/master`
- PR URL
- Merge commit SHA on `ciat/main` (from `gh pr view <PR_NUMBER> --json mergeCommit --repo …`)

If any step fails, stop immediately and surface the error verbatim — do not retry or work around it. Production-deploy failures need human eyes.
