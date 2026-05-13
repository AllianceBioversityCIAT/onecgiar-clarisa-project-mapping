---
name: Center-rep scoping bug pattern — compare project.centerId not resolved centerId
description: Common bug when adding center-rep permission checks after calling resolveExclusionCenter or similar helpers
type: feedback
---

When implementing center-rep action guards, always compare `project.centerId !== actor.centerId` BEFORE calling any helper that resolves the acting centerId. If you call `resolveExclusionCenter(actor, project)` first (which returns `actor.centerId` for center_rep), the subsequent check `centerId !== actor.centerId` is always false (both are the same value), so the guard never fires and cross-center actions are permitted.

**Why:** Found during QA-1 of Project Exclusion (May 2026). Center rep was allowed to exclude a project in another center. The exclusion was stored under center_id=1 (the rep's center) while pointing to a project in center_id=2, creating an orphaned exclusion that only affected center 1's view of a project they don't own.

**How to apply:** In any service method that checks center_rep ownership AND resolves a centerId, do the ownership check using `project.centerId` vs `actor.centerId` first, then call the resolver.
