# ECA 2.0.8: template mutable data in asset responses and in the data filters

Replaces `atomicassets_assets_master` so its nested `template` object carries
`mutable_data`, `deleted_at_time` and `deleted_at_block`, and indexes
`atomicassets_templates.mutable_data` for the two comparisons the template
filters make against it.

## Why

The nested object listed `immutable_data` alone. `formatAsset` already merges
`template.mutable_data` underneath the asset's own layers and `openapi.ts`
already documents all three fields, so an asset response reported
`template.mutable_data` as `{}` and dropped every key its template holds
mutably out of the merged `data`. A template deleted on chain was
indistinguishable from a live one in that response, because neither deletion
mark reached it. `atomicmarket_assets_master` opens with `SELECT asset.*`, so
every market listing inherited the same gap and inherits the repair.

The second half is the query side. The `data.*` and `template_data.*`
conditions, and the template name behind `match` and `search`, compared against
`immutable_data` only, so a value a collection stores mutably was reachable
through no filter at all. Those conditions match either column, and each
`mutable_data` arm needs the index its comparison uses. The containment arms are
served by a `jsonb_ops` GIN index on each column, mirroring
`atomicassets_templates_immutable_data_gin`; the name arms use `ILIKE` and the
`<%` word-similarity operator, which a `jsonb_ops` GIN index cannot serve, so
each takes a trigram GIST index on its column's extracted name, mirroring
`atomicassets_templates_name` from `1.3.7`. Postgres builds a `BitmapOr` only
when every arm is indexable, so an unindexed arm costs a sequential scan of the
whole templates table for the entire condition rather than for itself alone.

## Scope

The view replacement changes expressions inside one existing `json` column and
adds no column, so `CREATE OR REPLACE` preserves the signature and every
dependent view stays valid without `DROP ... CASCADE`. A view holds no rows, so
this is a catalog update and rewrites no data; its cost does not scale with the
size of `atomicassets_assets`.

Both indexes are built `CONCURRENTLY` from the deferred file, outside the
version's transaction, so neither takes a lock that blocks writes to
`atomicassets_templates`. Both scan the whole table to build, and the runner
awaits the deferred lane, so a filler upgrading a large deployment stays down
for the length of those builds.

Fresh installs take the GIN index from
`definitions/tables/atomicassets_tables.sql`, where `IF NOT EXISTS` then makes
the deferred statement a no-op. The trigram index cannot ship in that file,
because handler setup runs it ahead of every migration and `pg_trgm` is created
by `migrations/1.3.0/atomicmarket.sql`. It reaches a fresh install the way
`atomicassets_templates_name` always has, through the migration replay that a
`1.0.0` `dbinfo` seed puts every version above.

Every statement is repeatable. `CREATE OR REPLACE VIEW` rewrites the same
definition and `CREATE INDEX CONCURRENTLY IF NOT EXISTS` returns without work
once the index stands.

## Verification

After the migration runs, an asset whose template holds mutable data should
report it, and both indexes should be present and valid:

```sql
SELECT "template"->'mutable_data', "template"->'deleted_at_time'
  FROM atomicassets_assets_master
 WHERE contract = 'atomicassets' AND asset_id = <id>;

SELECT c.relname, i.indisvalid FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname IN ('atomicassets_templates_mutable_data_gin',
                     'atomicassets_templates_mutable_name');
-- expect: two rows, both t
```

The index query joins on the name rather than casting it, so a deferred phase
that never ran returns fewer rows instead of raising `42P01`. A missing row and
a row reporting false are different outcomes with the same repair.

A `CREATE INDEX CONCURRENTLY` cancelled part way leaves an invalid index under
its name, and `IF NOT EXISTS` skips it on any later run. The recovery is manual,
because `database.sql` commits the version bump before the deferred lane opens:
once `dbinfo` reads `2.0.8` no filler re-enters this version, so restarting the
filler rebuilds nothing. Drop the index by name, then re-run that index's
`CREATE INDEX CONCURRENTLY` statement from this directory's
`atomicassets-deferred.sql` by hand, outside a transaction.
`UPGRADING.md:## Interrupting an upgrade` carries the general form, including
the sweep that lists every invalid index.
