-- P2: Links listing composite (6.5M rows)
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomictools_links_contract_state_linkid
    ON atomictools_links (tools_contract, state, link_id DESC);
