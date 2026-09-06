-- ---------------------------------------------------------------------------
-- Revive preview_path, this time with a writer.
--
-- 0002 dropped preview_path because nothing ever wrote it. The studio can now
-- capture a small PNG of a version's mesh client-side and hand it back to
-- POST /api/assets/:assetId/versions/:versionId/preview, so the column is
-- worth having again. Note the asset_versions_immutable trigger (0001) still
-- applies: a version accepted before it ever got a preview stays without one,
-- since it can no longer be updated at all.
-- ---------------------------------------------------------------------------

alter table asset_versions add column if not exists preview_path text;
