-- ---------------------------------------------------------------------------
-- Decimated viewport mesh alongside the full-detail one (issue #47).
--
-- `reconstruct` now also writes a simplified copy of the mesh it produces,
-- for the real-time studio viewport (and, since it shares the same live
-- scene, the in-browser path tracer) - see lib/ai/mesh/simplify.ts. The
-- Blender render worker and glTF/OBJ export keep reading mesh_path
-- unconditionally; preview_mesh_path is null whenever simplification hasn't
-- run yet, failed, or would not have reduced the mesh at all, in which case
-- the viewport falls back to mesh_path (components/studio/AssetNode.tsx).
-- ---------------------------------------------------------------------------

alter table asset_versions add column if not exists preview_mesh_path text;
