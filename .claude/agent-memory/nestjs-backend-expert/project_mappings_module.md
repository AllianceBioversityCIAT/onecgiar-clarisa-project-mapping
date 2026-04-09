---
name: Mappings Module (Waves 4-5)
description: ProjectMapping entity with allocation validation, approval workflow, center rep review, and program rep submission
type: project
---

Waves 4 and 5 implemented the project-to-program mapping module with center approval workflow.

**Key entities/files:**
- `src/modules/mappings/entities/project-mapping.entity.ts` — ProjectMapping entity with UNIQUE(projectId, programId)
- `src/modules/mappings/enums/` — MappingStatus (pending/approved/rejected), Rating (high/medium/low)
- `src/modules/mappings/dto/` — CreateMappingDto, UpdateMappingDto, MappingQueryDto, RejectMappingDto
- `src/modules/mappings/mappings.service.ts` — Full CRUD + approve/reject/resubmit + allocation validation with pessimistic locking
- `src/modules/mappings/mappings.controller.ts` — REST endpoints including /approve, /reject, allocation summary, review summary
- Migration: `1775744766471-CreateProjectMappingsTable`

**Why:** Program reps map projects to their programs with allocation percentages (must total <= 100%). Center reps approve/reject mappings. Approval requires total allocation = 100%.

**How to apply:** When adding features that touch mappings, remember the allocation constraint, the role-based access (program_rep creates, center_rep reviews), and the resubmission flow (rejected -> update -> pending again).
