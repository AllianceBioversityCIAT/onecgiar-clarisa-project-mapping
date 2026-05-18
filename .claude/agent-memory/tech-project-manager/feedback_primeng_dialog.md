---
name: PrimeNG v21 Dialog and Textarea imports
description: Correct PrimeNG v21 component/module names for Dialog and Textarea — fixes build errors and Playwright test issues
type: feedback
---

`p-dialog` with `[(visible)]` works correctly with a plain boolean property (not an Angular Signal). Using a Signal for `[visible]` + `(visibleChange)` can miss change detection in some zone contexts.

`InputTextareaModule` does NOT exist in PrimeNG v21. Use `import { Textarea } from 'primeng/textarea'` and add `Textarea` to the component's `imports` array. The directive selector is `pInputTextarea` on a native `<textarea>` element.

**Why:** Build failed with "Unknown reference" on `InputTextareaModule`. Discovered during Angular production build in the Project Exclusion feature (May 2026).

**How to apply:** Whenever adding a textarea with PrimeNG styling to a standalone component, use `Textarea` from `primeng/textarea`, not `InputTextareaModule`.
