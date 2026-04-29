/*
  1.3.34 - Replace point-lookup btree on contract_traces with a HASH on
  global_sequence to fix a planner regression introduced by 1.3.31.

  Run manually BEFORE this migration on prod-sized DBs to avoid taking an
  ACCESS EXCLUSIVE lock on contract_traces during filler startup:

    SET statement_timeout = 0;
    SET lock_timeout = 0;

    -- 1. Build the replacement hash index.
    --    On WAX mainnet (~2.14B rows, ~750 GB table) this typically
    --    takes 60-120 minutes and requires ~30 GB of free space.
    CREATE INDEX CONCURRENTLY IF NOT EXISTS
      contract_traces_global_sequence_hash
      ON contract_traces USING hash (global_sequence);

    ANALYSE contract_traces;

    -- 2. Drop the regression-causing btree.
    --    Once the hash above is built and verified, this is safe.
    DROP INDEX CONCURRENTLY IF EXISTS contract_traces_global_sequence_account_idx;

  Background:

  1.3.31 added contract_traces_global_sequence_account_idx -- a btree on
  (global_sequence, account) -- to give the filler's rollback DELETE path
  sub-millisecond point lookups. It does that job correctly, but it also
  fits the planner's preferred shape for any query that looks like

      WHERE account = $1
      ORDER BY global_sequence DESC
      LIMIT N

  ...which is exactly what the eosio-contract-api `*/logs` endpoints
  produce via getContractActionLogs (api/utils.ts). For an old target id,
  the planner picks Parallel Index Scan Backward on this btree, applies
  the JSONB containment filter as a post-index check, and chews through
  millions of newer rows before finding matches -- busting the 30s
  statement_timeout. Observed on WAX mainnet for atomicmarket sale logs
  on 2026-04-29 (sale_id 172238298, 5 weeks old). Forced GIN on the same
  query: 36 ms. Same plan trap reproduces for atomicassets and
  atomictools: structural across all 10 getContractActionLogs callers.

  Production usage stats (eca-wax-mainnet replica, since last stat reset):
    contract_traces_global_sequence_account_idx: 172,607 scans /
                                                 9.07 trillion tuples read
    contract_traces_metadata (GIN):              33,411 scans
  Translation: the btree is being misused at scale; almost no query
  benefits from its (global_sequence, account) ordering.

  Why hash on global_sequence:
  - The rollback DELETE filter is `global_sequence = $1 AND account = $2`.
    Hash supports the equality lookup; account becomes a heap recheck on
    the 1-3 rows per global_sequence (one per notified account). Primary's
    measured rollback workload is 143 scans / 143 tuples since 1.3.31, so
    the recheck cost is irrelevant in practice.
  - Hash indexes cannot satisfy ORDER BY, so the planner is structurally
    blocked from re-falling into the trap.
  - Hash on bigint is smaller than the 81 GB btree it replaces (~30-50 GB
    expected on WAX mainnet).

  Trade-offs to accept:
  - The nft-data-api offline importer's MIN/MAX(global_sequence) probes
    fall back to BRIN+seq. The importer is a one-shot batch tool, not on
    the API hot path; the regression is bounded.
  - During the manual pre-migration window both indexes coexist (~80 GB
    extra on disk). Verified WAX cluster has headroom; smaller chains
    should be checked before running.

  The CONCURRENTLY variant above is the actual rollout path. The fallback
  below ensures both states converge for greenfield deployments that skip
  the manual step.
*/

CREATE INDEX IF NOT EXISTS
  contract_traces_global_sequence_hash
  ON contract_traces USING hash (global_sequence);

DROP INDEX IF EXISTS contract_traces_global_sequence_account_idx;

ANALYSE contract_traces;

UPDATE dbinfo SET "value" = '1.3.34' WHERE name = 'version';
