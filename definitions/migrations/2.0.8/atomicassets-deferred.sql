-- 2.0.8 deferred - index the template's mutable_data for the two comparisons
-- the template filters make against it. Runs OUTSIDE the migration transaction
-- because CREATE INDEX CONCURRENTLY cannot run inside one; the deferred runner
-- strips these line comments, splits on the semicolons below and executes each
-- statement on its own autocommit connection.
--
-- The template data filters (data.* and template_data.*) and the template name
-- behind match and search compare against both of the template's data columns.
-- Each column needs its own index, and the two comparisons need different
-- index types, so immutable_data's pair below is mirrored rather than reused.
--
-- Postgres builds a BitmapOr only when every arm of the OR is indexable, so an
-- arm with no index of its own does not merely lose its own index: it forces a
-- sequential scan of the whole templates table for the entire condition.
--
-- Containment (@>) is served by a jsonb_ops GIN index, matching
-- atomicassets_templates_immutable_data_gin.
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_templates_mutable_data_gin ON atomicassets_templates USING gin (mutable_data);

-- ILIKE and the <% word-similarity operator are served by a trigram GIST index
-- on the extracted name, matching atomicassets_templates_name from 1.3.7. A
-- jsonb_ops GIN index serves neither operator, so the index above does not
-- cover this arm.
CREATE INDEX CONCURRENTLY IF NOT EXISTS atomicassets_templates_mutable_name ON atomicassets_templates USING GIST ((mutable_data->>'name') gist_trgm_ops);
