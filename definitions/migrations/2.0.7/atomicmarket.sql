/*
  2.0.7 - Cutover seed for atomicmarket_template_prices_updates
  (see database.sql for why this is a version of its own rather than one more
  statement in 2.0.6's transaction).

  WHAT IT SEEDS
  Every template currently priced (atomicmarket_template_prices) union every
  template currently priceable (the distinct set behind
  atomicmarket_stats_prices_master), at bulk priority so it cannot delay a
  real-time enqueue. That makes the cutover complete in both directions: every
  template with inputs is recomputed once by the incremental drain, and every
  price row whose template no longer has inputs is claimed, recomputed to empty
  inputs, and deleted by the drain that claims it.

  Live rows only. A seeded template arms its own aging boundary on the drain that
  claims it, which is what covers the listings and sales already in flight when
  this version lands; seeding aging rows here would duplicate that and could only
  name one boundary per template where the drain's arm names the earliest across
  both input classes.

  ON CONFLICT DO NOTHING rather than DO UPDATE: a template the triggers already
  enqueued between 2.0.6's COMMIT and this statement is fresher than the seed,
  and on a replay the seed must not bump seq or push a live prio-0 row back into
  the bulk lane.

  COST AND BOOT DELAY
  The second arm is a full scan of atomicmarket_stats_markets. Measured on a
  production-sized WAX replica the SELECT runs about 10.5s, and the statement
  including the insert about 15s. That is the bound on how long the filler's boot
  is delayed by this version, and unlike the DDL in 2.0.6 it is paid while
  holding only ACCESS SHARE on the tables it reads, so API readers are unaffected
  for its duration. Smaller chains scale down from there.

  Idempotent on replay: ON CONFLICT DO NOTHING, and a drained queue simply
  re-seeds (harmlessly, since a recompute of an already-current template writes
  nothing).
*/

INSERT INTO atomicmarket_template_prices_updates (market_contract, assets_contract, template_id, kind, prio, refresh_at)
    SELECT s.market_contract, s.assets_contract, s.template_id, 0, 1, 0
    FROM (
        SELECT market_contract, assets_contract, template_id
        FROM atomicmarket_template_prices
        UNION
        SELECT market_contract, assets_contract, template_id
        FROM atomicmarket_stats_prices_master
        WHERE template_id IS NOT NULL
    ) s
ON CONFLICT (market_contract, assets_contract, template_id, kind) DO NOTHING;
