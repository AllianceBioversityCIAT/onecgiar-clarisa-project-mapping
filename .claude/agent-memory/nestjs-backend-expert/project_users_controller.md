---
name: Users Controller & PATCH endpoint
description: Admin-only GET /users and PATCH /users/:id with role-constraint validation (program_rep needs programId, center_rep needs centerId)
type: project
---

UsersController added to UsersModule with two admin-only endpoints:

- **GET /users** — Returns all users with program/center relations loaded
- **PATCH /users/:id** — Updates role, programId, centerId, isActive with cross-field validation

Validation rules enforced in controller:
- program_rep requires programId, cannot have centerId
- center_rep requires centerId, cannot have programId
- admin cannot have programId or centerId

**Why:** Admin needs to manage user roles and associations from the UI.
**How to apply:** UpdateUserDto uses class-validator; cross-field validation is in the controller's private method.
