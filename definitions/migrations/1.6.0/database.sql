-- 1.6.0 has no shared/cross-handler schema changes. The atomicpacksx handler
-- rewrite (driven by contract row deltas instead of action listeners) is
-- backwards-compatible with the existing 1.5.1 schema - no DDL needed.
--
-- File exists because src/filler/upgrade-db.ts unconditionally readFileSync's
-- database.sql for every migration version dir. (init-test-db.ts is more
-- forgiving via existsSync; the discrepancy is documented in 1.5.1's
-- database.sql comment and remains a TODO for upgrade-db.)
SELECT 1;
