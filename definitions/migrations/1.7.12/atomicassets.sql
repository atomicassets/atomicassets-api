/*
  1.7.12 - Converge the legacy atomicassets_transfers primary key to (contract, transfer_id).

  PROBLEM
  definitions/tables/atomicassets_tables.sql declares
      CONSTRAINT atomicassets_transfers_pkey PRIMARY KEY (contract, transfer_id)
  and the filler write-buffer upserts transfers with
      INSERT INTO atomicassets_transfers (...) ON CONFLICT (contract, transfer_id) DO UPDATE
  (src/filler/handlers/atomicassets/processors/assets.ts). Databases created before the
  transfers primary key gained the `contract` column still carry PRIMARY KEY (transfer_id)
  only, and no migration ever converged them. On those clusters the upsert raises
      42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
  and the filler crash-loops on the first transfer block after upgrading. Fresh installs are
  unaffected - their composite primary key already provides the needed unique index.

  FIX
  If no unique index already covers exactly (contract, transfer_id), build one. A UNIQUE INDEX
  (not a primary-key swap) is deliberate: it is all the ON CONFLICT inference needs, it does not
  drop the existing primary key (which legacy foreign keys may depend on), and it is a no-op on
  fresh installs whose composite primary key already satisfies the check below.

  This runs in the boot upgrade transaction (reader not yet started). On large chains transfers
  is big (~350M rows on WAX mainnet), so SET LOCAL lifts the migration pool's 30s
  statement_timeout for the one-time build, exactly as 1.6.4 / 1.7.11 do. The build takes a
  brief ACCESS EXCLUSIVE lock; operators who cannot take it at boot can pre-build it online
  beforehand, after which this migration is a no-op:
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_transfers_contract_transfer_id_uniq
          ON atomicassets_transfers (contract, transfer_id);
*/

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '60s';

DO $$
BEGIN
    -- Skip when a unique index already covers exactly {contract, transfer_id} (fresh installs:
    -- the composite primary key; clusters where the online pre-build above was run).
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = 'atomicassets_transfers'::regclass
            AND i.indisunique
            AND i.indpred IS NULL
            AND (
                -- attname is type `name`; cast to text so it compares to the text[] literal.
                -- ORDER BY ... COLLATE "C" makes the set's ordering byte-stable regardless of the
                -- database's default collation, so the equality below is deterministic.
                SELECT array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C")
                FROM unnest(i.indkey) AS k(attnum)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            ) = ARRAY['contract', 'transfer_id']
    ) THEN
        -- IF NOT EXISTS guards the rare TOCTOU where an operator runs the documented online
        -- CONCURRENTLY pre-build at the same time as this upgrade.
        CREATE UNIQUE INDEX IF NOT EXISTS atomicassets_transfers_contract_transfer_id_uniq
            ON atomicassets_transfers (contract, transfer_id);
    END IF;
END
$$;
