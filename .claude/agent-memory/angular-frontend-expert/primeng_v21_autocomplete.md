---
name: PrimeNG v21 AutoComplete API
description: AutoComplete uses optionLabel (not field) in PrimeNG v21; FormsModule required for ngModel on p-select in standalone components
type: feedback
---

In PrimeNG v21 the `p-autoComplete` component no longer accepts `[field]` — use `optionLabel` (string attribute, no binding brackets needed for a plain string value).

**Why:** The `field` input was removed/renamed in the v21 API. The d.ts declaration shows `optionLabel` as the accepted input.

**How to apply:** When building AutoComplete with object suggestions, always use `optionLabel="name"` (or whichever object property). Never `[field]="'name'"`.

Also: standalone components using `[ngModel]` on PrimeNG selects (`p-select`) must include `FormsModule` in their `imports` array — `ReactiveFormsModule` alone is not sufficient for template-driven `ngModel` binding.
