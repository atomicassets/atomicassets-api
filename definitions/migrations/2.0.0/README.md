# ECA 2.0.0 — AtomicAssets v2 migration notes

## Deferred from the upstream OIG PR (handled separately / flagged for audit)

- `update_atomicmarket_sales_filters` `nx`/`nb` (non-transferable / non-burnable)
  filter flags — the upstream PR rewrote the whole function off an old base; not
  ported here to avoid regressing the 1.6/1.7 drain-hardened version. Tracked in
  the v2 audit as a follow-up to graft onto the current function.
- Collection `data` update-blacklist change — left at canonical behavior; flagged
  for audit (could regress collection-data indexing).
