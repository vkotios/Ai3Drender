-- ---------------------------------------------------------------------------
-- Perceptual QA result for a reconstructed mesh (issue #43).
--
-- gltf-transform's round-trip only ever checked that a mesh was structurally
-- valid glTF - never that it actually looked like the photos it was built
-- from. `reconstruct` now optionally renders a couple of stock views of the
-- new mesh and asks Gemini vision to score its fidelity against the source
-- photographs; the verdict is stored here.
--
-- Always a soft signal, never a gate: nothing reads this column to decide
-- whether a version can be accepted or used, and the asset_versions_immutable
-- trigger (0001) still applies the same as every other column.
-- ---------------------------------------------------------------------------

alter table asset_versions add column if not exists qa_result jsonb;
