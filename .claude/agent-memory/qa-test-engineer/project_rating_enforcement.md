---
name: Program-rep rating enforcement QA (Task 9)
description: Verified rating gate on agree/counter-propose: program_rep requires both fields, all other roles exempt. Confirmed DB persistence and suffix format.
type: project
---

QA Task 9 completed 2026-05-05. All 8 cases passed.

Test mapping: id=3695, project_id=5709, program_id=5 (Better Diets and Nutrition), center_id=9 (ICRISAT).
No center_rep user exists for center_id=9; admin was used as center-side actor throughout.

Key findings:
- `validateAndApplyRatings()` in mappings.service.ts is the sole enforcement point (line 1612).
- DTO-level `@IsEnum(Rating)` fires first for invalid enum values (400 with validation array message).
- Service-level `BadRequestException` fires for missing-one or missing-both on program_rep (400 with plain string message).
- Agree suffix format (no base justification): `[C:high E:medium]` (trimStart applied).
- Counter-propose suffix format: `Coverage confirmed by workplan review [C:medium E:low]` (space-prefixed, appended to justification).
- Admin ratings in body silently ignored — DB values unchanged.
- Both `/consolidated` and `/allocation` expose `complementarityRating`/`efficiencyRating` per mapping.

**Why:** Post-Wave 8 feature — program reps must rate mappings when agreeing or counter-proposing.
**How to apply:** Re-run test matrix if rating enforcement logic changes. Use mapping 3695 / project 5709 as regression baseline.
