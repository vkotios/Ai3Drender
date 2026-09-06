-- ---------------------------------------------------------------------------
-- Wire up the 'viewer' share role that 0008_client_review_links.sql already
-- reserved: a link that grants read access only, with no note-pinning and no
-- setting the approval verdict.
--
-- `active_share_scene_id()` deliberately does not check role - both tiers can
-- view - so the write-side policies below are the only place role has to be
-- enforced. `active_share_role()` is the read counterpart of that function:
-- same token/hash/expiry/revocation lookup, returning the link's role instead
-- of its scene, so RLS can gate a write on it without a second round trip
-- through the app.
--
-- Caveat: as with 0008, this project has no live Supabase instance wired into
-- this sandbox, so this policy change could not be exercised against real
-- PostgREST in review. It was verified against the local-disk `Store` path
-- instead (see lib/share/access.ts and the 403 checks in
-- app/api/share/[token]/annotations and .../review), where the same
-- token → role resolution and write gate are implemented directly in
-- TypeScript rather than SQL.
-- ---------------------------------------------------------------------------

create or replace function active_share_role()
returns text
language sql
security definer
set search_path = public, extensions
stable
as $$
  select l.role
  from scene_share_links l
  where l.token_hash = encode(
          digest(coalesce(current_setting('request.headers', true)::json->>'x-scene-share-token', ''), 'sha256'
        ), 'hex')
    and l.revoked_at is null
    and (l.expires_at is null or l.expires_at > now())
  limit 1;
$$;

grant execute on function active_share_role() to anon, authenticated;

-- Pinning a note: only a 'commenter' link may insert one.
drop policy if exists annotations_shared_insert on annotations;
create policy annotations_shared_insert on annotations
  for insert
  with check (
    source = 'client'
    and asset_version_id in (select id from shared_asset_version_ids())
    and scene_id = active_share_scene_id()
    and active_share_role() = 'commenter'
  );

-- Setting the approval verdict: same restriction, on top of the existing
-- column-narrowing note in 0008 (RLS cannot restrict columns, only rows -
-- app/api/share/[token]/review is what actually narrows the update to the
-- client_approval_* fields; this policy is the row-level half of that gate).
drop policy if exists scenes_shared_review on scenes;
create policy scenes_shared_review on scenes
  for update
  using (id = active_share_scene_id())
  with check (id = active_share_scene_id() and active_share_role() = 'commenter');
