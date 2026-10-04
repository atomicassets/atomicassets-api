/*
  2.0.13 - original_mint column on atomicassets_assets_master

  The master view gains original_mint as its last column, through a LEFT JOIN
  on the link table that 2.0.12 created. The handler's upgrade() re-applies
  the view for this version. The version has no table DDL of its own, and
  database.sql runs on every install, including the ones that configure no
  atomicassets handler, so it only advances the version.
*/

UPDATE dbinfo SET "value" = '2.0.13' WHERE name = 'version';
