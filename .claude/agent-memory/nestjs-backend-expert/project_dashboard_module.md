---
name: Dashboard Module
description: BE-7.1: Role-aware dashboard endpoints (summary, allocation-status, recent-activity) with 2-min per-user cache
type: project
---

Dashboard module provides three GET endpoints under `/api/dashboard/`:

- **summary** — Admin gets system-wide counts; program_rep gets own mapping stats; center_rep gets own center stats
- **allocation-status** — Projects sorted by least allocated first (top 50), center_rep filtered to own center
- **recent-activity** — Last 20 mapping events with type derived from mapping status

All endpoints use TypeORM QueryBuilder aggregates (no N+1). 2-minute in-memory cache keyed by user.id + endpoint.

**Why:** Frontend dashboard needs role-specific aggregated data without multiple round-trips.
**How to apply:** When adding new dashboard metrics, follow the same cache pattern and role-switching in the service.
