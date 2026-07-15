/**
 * Pure helpers for the v2 late-upgrader startup guard.
 *
 * Kept free of RPC/DB access so the decision logic is unit-testable without a
 * live chain or database - see AtomicAssetsHandler.init (index.ts) for the
 * side-effecting caller and processors/config.ts for the passive marker write
 * on a live tokenconfigs delta.
 */

/**
 * Parses the leading major version component out of a `tokenconfigs.version`
 * string (e.g. "2.0.0" -> 2). Returns null for anything that does not match
 * `<major>.<minor>.<patch>` - callers must treat null as "unknown" and skip
 * the guard with a warning rather than blocking startup on an unparseable
 * value.
 */
export function parseContractMajorVersion(version: string | undefined | null): number | null {
    if (typeof version !== 'string') {
        return null;
    }

    const match = version.trim().match(/^(\d+)\.\d+\.\d+$/);

    if (!match) {
        return null;
    }

    const major = Number(match[1]);

    return Number.isFinite(major) ? major : null;
}

export type V2GuardDecision =
    | 'proceed' // nothing to do: pre-v2 chain, unknown version, or already satisfied
    | 'write-marker' // accept_v2_gap: proceed, but record the marker at the reader's block
    | 'block'; // refuse to start

export interface V2GuardParams {
    /** Parsed major version of the chain's current tokenconfigs, or null if unknown/unparseable. */
    majorVersion: number | null;
    /** Whether contract_readers.block_num > 0 for this reader (i.e. not a fresh sync). */
    hasReaderPosition: boolean;
    /** Whether atomicassets_config.v2_marker_block is already non-null for this contract. */
    markerAlreadySet: boolean;
    /** The reader arg override. */
    acceptGap: boolean;
}

/**
 * Evaluates the v2 late-upgrader guard against a chain's current tokenconfigs
 * and this reader's stored state. See design.md ("Startup guard") for the
 * full rationale; this function only encodes the decision table.
 */
export function evaluateV2Guard(params: V2GuardParams): V2GuardDecision {
    const { majorVersion, hasReaderPosition, markerAlreadySet, acceptGap } = params;

    // Unknown version (RPC failure or malformed string) or a pre-v2 chain:
    // nothing for the guard to check.
    if (majorVersion === null || majorVersion < 2) {
        return 'proceed';
    }

    // A fresh sync has no gap to have missed; it picks up the marker itself
    // once its live reader observes the tokenconfigs delta (or the flip is
    // already behind it, in which case the delta was already replayed).
    if (!hasReaderPosition) {
        return 'proceed';
    }

    if (markerAlreadySet) {
        return 'proceed';
    }

    if (acceptGap) {
        return 'write-marker';
    }

    return 'block';
}
