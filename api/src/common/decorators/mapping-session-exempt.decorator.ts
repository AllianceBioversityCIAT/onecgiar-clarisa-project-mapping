import { SetMetadata } from '@nestjs/common';

/** Reflector key read by `MappingSessionGuard`. */
export const MAPPING_SESSION_EXEMPT_KEY = 'mappingSessionExempt';

/**
 * Marks a route as still writable after the annual mapping session has been
 * closed, exempting it from {@link MappingSessionGuard}.
 *
 * **TOC contribution is the only intended exemption.** Programs are expected
 * to keep documenting how a project contributes to their theory of change
 * after the allocation round is over — the same reason TOC links stay
 * editable on a locked project round. Everything else that changes a mapping
 * (allocations, agreement, removal, lock state, chat, imports) is frozen by
 * design, so do not reach for this decorator to unblock a new endpoint.
 */
export const MappingSessionExempt = () =>
  SetMetadata(MAPPING_SESSION_EXEMPT_KEY, true);
