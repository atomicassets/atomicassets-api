/**
 * Parse a positive-integer environment variable, falling back to `def` for
 * unset / non-numeric / zero / negative values.
 *
 * The bare `parseInt(process.env.X ?? '', 10) || def` idiom only catches NaN and
 * 0 (both falsy); a negative like `-1` is truthy and slips through, which can be
 * actively harmful — e.g. a negative watchdog timeout fires instantly (crash/
 * restart loop) and a non-positive work_mem produces an invalid `SET LOCAL`.
 */
export function positiveIntEnv(name: string, def: number): number {
    const v = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : def;
}
