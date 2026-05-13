---
name: feedback-streaming-response-errors
description: When piping a stream to an Express @Res() response, wrap the post-pipe block in try/catch and destroy() the source stream on error — otherwise frontend HttpClient hangs silently
metadata:
  type: feedback
---

When a NestJS controller uses `@Res()` to pipe a stream (ExcelJS WorkbookWriter, CSV, file download, etc.) directly to the Express response, you MUST wrap every line of code after `sourceStream.pipe(res)` in a try/catch.

**Why:** Once a single byte has been written to `res`, the HTTP status code and headers are locked. If any subsequent code throws — a null pointer in a sheet writer, an entity-relation mismatch, a downstream repo call that errors — the global `AllExceptionsFilter` cannot turn that into a JSON 500. It tries to call `response.status(500).json(...)` and silently fails with "Cannot set headers after they are sent." The connection just hangs until the browser's read timeout (often minutes). The QA bug shows up as "starts the request but never delivers a file and never shows an error."

**How to apply:**
- All data fetches (DB, audit queries) MUST happen BEFORE `res.setHeader(...)` and BEFORE creating the streaming writer. Throwing pre-headers produces a clean 4xx/5xx via the exception filter.
- Wrap the post-pipe sheet/data-writing + `commit()` + finish-wait block in `try { … } catch (err) { this.logger.error(…, stack); passThrough.destroy(err); return; }`.
- Use `passThrough.destroy(err)` (not `.end()`) so the piped Express response is torn down with the error — the client's HttpClient blob request observes an error event instead of waiting forever.
- Do NOT re-throw from the catch block once headers are sent; the exception filter can't do anything useful with it, and the warning pollutes logs.
- Apply this to BOTH the file streaming pattern AND server-sent-events, websocket upgrades, anywhere a response is partially flushed before the work completes.

Concrete precedent: `api/src/modules/projects/services/projects-export.service.ts` — `streamDetailExport` and `streamListExport` both follow this pattern after the QA Round 1 bug #4 fix. The block also defends against `AuditService.applyVisibilityScope()` throwing `ForbiddenException` for `center_rep`/`program_rep` callers (the audit endpoint is admin/unit_admin/workflow_admin-only, but the export endpoint is open to every role); `loadProjectAuditEvents` catches that 403 and returns `[]` so the export degrades to an empty Audit sheet rather than failing.
