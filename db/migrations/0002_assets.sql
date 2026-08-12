-- ============================================================================
-- 0002 — Locations, products, assets, tags, containment, bulk stock, kits, jobs
--
-- The hard part of the schema. Five things that naive designs conflate:
--
--   1. Product            "Sony FX9" — a catalogue entry
--   2. Serialized asset   one physical body, one serial, one QR tag, one history
--   3. Bulk stock         200m of gaffer tape — counted, not identified
--   4. Kit / container    a Pelican case that HOLDS other assets; itself an asset
--   5. Permanent accessory  the FX9 handle — moves with its parent, not rentable
--
-- Two tables, not one: `assets` (things with identity) and `stock_lots`
-- (things with quantity). A single table with a tracking_mode flag was
-- considered and rejected — every query would carry a mode branch, and bulk
-- genuinely lacks the columns that make an asset an asset (serial, condition,
-- service history, scan identity, containment). Forcing them together gives a
-- table where half the columns are null half the time and the constraints
-- cannot be expressed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- global_products — the cross-vendor catalogue
--
-- NOT org-scoped, and readable by everyone. This is the one genuinely
-- irreversible decision that the future marketplace integration forces on us
-- today: a marketplace needs "Sony FX9" to be ONE thing across every vendor,
-- or cross-vendor search, comparison and availability are impossible.
--
-- Retrofitting a global catalogue over fifty orgs' free-text manufacturer/model
-- rows is a data-cleaning project that will never be scheduled and never be
-- finished. One day now; impossible later.
-- ---------------------------------------------------------------------------
create table global_products (
  id            uuid primary key default uuid_generate_v7(),
  category      text not null,
  manufacturer  text not null,
  model         text not null,
  display_name  text not null,
  specs         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index global_products_ident_idx
  on global_products (lower(manufacturer), lower(model));

-- ---------------------------------------------------------------------------
-- locations — where a thing physically is
--
-- parent_id plus a materialised text path, NOT ltree. A Lahore rental house
-- has one warehouse and some shelves; ltree with a GiST index is machinery for
-- a problem nobody has yet. Add it when someone has two warehouses.
--
-- Vehicles are locations. That is deliberate and it is what makes "where is it
-- right now" answerable at 6am: gear on a truck is not missing, it is at a
-- location that happens to be moving.
-- ---------------------------------------------------------------------------
create table locations (
  id          uuid primary key default uuid_generate_v7(),
  org_id      uuid not null references orgs(id) on delete restrict,
  parent_id   uuid references locations(id) on delete restrict,

  name        text not null,
  kind        text not null default 'shelf',
  path        text not null default '',   -- 'Warehouse / Rack A / Shelf 3'
  code        text,                       -- printed on the location QR label

  -- Cycle counting is the ONLY mechanism that catches gear lost without ever
  -- being scanned out. Recording when a location was last fully counted is
  -- what turns "we tagged some of it" into an honest, visible progress ladder.
  last_counted_at  timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint locations_kind_check
    check (kind in ('warehouse', 'room', 'rack', 'shelf', 'bin', 'vehicle', 'service', 'offsite')),
  constraint locations_no_self_parent check (parent_id is null or parent_id <> id)
);

create index locations_org_parent_idx on locations (org_id, parent_id) where deleted_at is null;
create unique index locations_org_code_live_idx on locations (org_id, code)
  where code is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- products — an org's catalogue entry
-- ---------------------------------------------------------------------------
create table products (
  id                 uuid primary key default uuid_generate_v7(),
  org_id             uuid not null references orgs(id) on delete restrict,

  -- Nullable on purpose: a house can catalogue anything, including gear the
  -- global catalogue has never heard of. The importer fuzzy-matches and asks
  -- the operator to confirm rather than guessing.
  global_product_id  uuid references global_products(id) on delete restrict,

  category           text not null,
  manufacturer       text not null default '',
  model              text not null default '',
  display_name       text not null,

  -- serialized -> individually tagged, tracked in `assets`
  -- bulk       -> counted, tracked in `stock_lots`
  -- An operator WILL start something as bulk and regret it, so this is
  -- changeable later; the two tables make the migration explicit rather than
  -- silent.
  tracking_mode      text not null default 'serialized',

  specs              jsonb not null default '{}'::jsonb,
  replacement_value_minor  bigint,   -- for damage claims and insurance
  hero_image_path    text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  constraint products_tracking_mode_check
    check (tracking_mode in ('serialized', 'bulk', 'consumable'))
);

create index products_org_category_idx on products (org_id, category) where deleted_at is null;
create index products_org_global_idx on products (org_id, global_product_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- assets — one physical thing with an identity
--
-- STATUS IS THREE COLUMNS, NOT ONE.
--
-- The original design had a single twelve-value status column. It cannot
-- represent a sub-rented lens that is currently out on a job — `sub_rented_in`
-- and `out` are mutually exclusive values and both are true. The twelve values
-- were three independent questions crammed together:
--
--   presence  — where is it?      here / out / in_transit / gone
--   health    — is it usable?     ok / servicing / quarantined
--   ownership — whose is it?      owned / sub_rented_in
--
-- The UI consequence matters as much as the data one: a single column
-- answering three questions cannot be rendered as one glanceable indicator,
-- because any badge you draw is lying about two of them.
--
-- All three are PROJECTIONS, rebuilt from scan_events. A client never writes
-- them directly.
-- ---------------------------------------------------------------------------
create table assets (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,
  product_id   uuid not null references products(id) on delete restrict,

  -- Human-facing label, printed on the tag face. Generated from a Crockford
  -- base32 alphabet with O, I, L, U excluded, because "FX9-02" vs "FX9-O2" is
  -- read at arm's length in bad light by someone holding a case.
  asset_code   text not null,
  serial_number text,

  is_container boolean not null default false,  -- a case/kit body
  rentable     boolean not null default true,   -- false for permanent accessories

  purchase_date        date,
  purchase_price_minor bigint,

  -- ---- projections, derived from scan_events. never client-written ----
  presence     text not null default 'here',
  health       text not null default 'ok',
  ownership    text not null default 'owned',

  current_location_id uuid references locations(id) on delete restrict,
  current_parent_id   uuid references assets(id) on delete restrict,
  last_scanned_at     timestamptz,

  -- Ordering key of the newest applied event, so a late-arriving event from a
  -- device that was offline for days cannot clobber newer truth.
  last_applied_key    text,

  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint assets_presence_check
    check (presence in ('here', 'out', 'in_transit', 'gone')),
  constraint assets_health_check
    check (health in ('ok', 'servicing', 'quarantined')),
  constraint assets_ownership_check
    check (ownership in ('owned', 'sub_rented_in')),
  constraint assets_no_self_parent
    check (current_parent_id is null or current_parent_id <> id),
  -- A permanent accessory is not independently rentable, and a container that
  -- is not rentable is a storage box rather than a kit. Neither is an error,
  -- but a container that is ALSO a permanent accessory is nonsense.
  constraint assets_container_not_accessory
    check (not (is_container and not rentable))
);

create unique index assets_org_code_live_idx on assets (org_id, asset_code) where deleted_at is null;
create unique index assets_org_serial_live_idx on assets (org_id, lower(serial_number))
  where serial_number is not null and deleted_at is null;

-- org_id first in every composite index — this is the RLS access path.
create index assets_org_presence_idx on assets (org_id, presence) where deleted_at is null;
create index assets_org_product_idx  on assets (org_id, product_id) where deleted_at is null;
create index assets_org_location_idx on assets (org_id, current_location_id) where deleted_at is null;
create index assets_org_parent_idx   on assets (org_id, current_parent_id) where current_parent_id is not null;

-- ---------------------------------------------------------------------------
-- asset_tags — the QR label
--
-- THE TAG IS AN OPAQUE RANDOM ID, NOT THE ASSET ID. Five reasons, all load-
-- bearing:
--
--   1. Re-issue.    Labels get soaked, peeled, gaffed over, stuck on the wrong
--                   item. You must be able to print a NEW label for the SAME
--                   asset. If the tag is the asset id you cannot distinguish
--                   "new label" from "different asset".
--   2. Revocation.  A peeled label found on the floor must say "retired on
--                   12 Mar", not "here is the FX9".
--   3. Pre-printing. You print rolls of blank tags in advance and bind them at
--                   intake. This is what makes tag-by-rack onboarding possible
--                   at all — with asset-id tags you can only print after the
--                   asset exists, one at a time.
--   4. No leakage.  A tag reveals nothing about org, value or fleet size to
--                   someone photographing a case in a hotel lobby.
--   5. Transfer.    Unbinding on sale is a row update, not a re-labelling job.
--
-- tag_code is GLOBALLY unique, not per-org, so the public resolver is a single
-- lookup and a tag can never be ambiguous if two houses merge or one sub-rents
-- to another. The row itself is still org-scoped by RLS.
--
-- Generated with gen_random_bytes (a CSPRNG), server-side only. Never
-- Math.random(), never a sequential batch counter: a guessable tag lets a
-- competitor enumerate your fleet through the public resolver.
-- ---------------------------------------------------------------------------
create table asset_tags (
  id          uuid primary key default uuid_generate_v7(),
  org_id      uuid not null references orgs(id) on delete restrict,

  tag_code    text not null,
  asset_id    uuid references assets(id) on delete restrict,   -- null = printed, unbound

  status      text not null default 'unbound',
  label_batch text,                       -- which print run, for recalls

  bound_at    timestamptz,
  unbound_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint asset_tags_status_check
    check (status in ('unbound', 'active', 'retired', 'lost')),

  -- An active tag must point at something; an unbound one must not. A retired
  -- or lost tag may keep its asset_id, because that is the historical record
  -- of what the label used to be on — which is the whole point of being able
  -- to re-issue a label.
  --
  -- Written as an explicit disjunction rather than a clever equivalence. The
  -- first version of this was a nested `(a) = (b and c) or d` that nobody
  -- (including its author) could evaluate by reading it.
  constraint asset_tags_status_asset_check check (
    (status = 'unbound' and asset_id is null)
    or (status = 'active' and asset_id is not null)
    or status in ('retired', 'lost')
  )
);

create unique index asset_tags_code_idx on asset_tags (tag_code);
-- One active tag per asset. Re-issuing means retiring the old row first.
create unique index asset_tags_asset_active_idx on asset_tags (asset_id)
  where status = 'active';
create index asset_tags_org_status_idx on asset_tags (org_id, status);

-- 128 bits of CSPRNG entropy, base32-encoded, with a version prefix so a
-- future format change is detectable.
create or replace function generate_tag_code()
returns text
language sql
volatile
as $$
  select 'v1' || translate(encode(gen_random_bytes(16), 'base64'), '+/=', 'xyz')
$$;

comment on function generate_tag_code() is
  'Opaque 128-bit tag code. CSPRNG only — a guessable code lets a competitor enumerate a fleet through the public resolver.';

-- ---------------------------------------------------------------------------
-- asset_containment — what is inside what
--
-- The "case came back but the battery plate didn't" problem.
--
--   permanent — welded to the parent (an FX9 handle). Moves with it, always.
--   packed    — currently living in this case, expected back in it.
--
-- That distinction is not cosmetic: scanning a case may emit implied events
-- for `permanent` children only. For `packed` children it must open a manifest
-- of UNCONFIRMED rows, because `packed` means "we believe this is in there",
-- and turning a belief into a recorded fact with a timestamp and an actor
-- fabricates evidence against a client who is right.
-- ---------------------------------------------------------------------------
create table asset_containment (
  id              uuid primary key default uuid_generate_v7(),
  org_id          uuid not null references orgs(id) on delete restrict,
  parent_asset_id uuid not null references assets(id) on delete restrict,
  child_asset_id  uuid not null references assets(id) on delete restrict,

  relation        text not null default 'packed',
  expected        boolean not null default true,  -- is it SUPPOSED to be here

  added_at        timestamptz not null default now(),
  removed_at      timestamptz,

  constraint asset_containment_no_self check (parent_asset_id <> child_asset_id),
  constraint asset_containment_relation_check
    check (relation in ('permanent', 'packed', 'subrented'))
);

-- THE line that matters: a physical thing can be inside at most one container
-- at a time. Eliminates an entire class of "the plate is in two cases" bugs.
create unique index asset_containment_child_live_idx
  on asset_containment (child_asset_id) where removed_at is null;
create index asset_containment_parent_idx
  on asset_containment (org_id, parent_asset_id) where removed_at is null;

-- ---------------------------------------------------------------------------
-- stock_lots / stock_movements — bulk
--
-- qty_on_hand is a PROJECTION. Truth is stock_movements, an append-only ledger
-- of deltas, so a miscount is corrected by appending an adjustment rather than
-- by editing the number. Same discipline as the scan log, for the same reason:
-- the correction must be visible.
-- ---------------------------------------------------------------------------
create table stock_lots (
  id                uuid primary key default uuid_generate_v7(),
  org_id            uuid not null references orgs(id) on delete restrict,
  product_id        uuid not null references products(id) on delete restrict,
  location_id       uuid not null references locations(id) on delete restrict,

  qty_on_hand       integer not null default 0,
  reorder_threshold integer,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint stock_lots_qty_nonneg check (qty_on_hand >= 0)
);

create unique index stock_lots_ident_idx on stock_lots (org_id, product_id, location_id);

create table stock_movements (
  id            uuid primary key default uuid_generate_v7(),
  org_id        uuid not null references orgs(id) on delete restrict,
  stock_lot_id  uuid not null references stock_lots(id) on delete restrict,

  kind          text not null,
  delta         integer not null,
  observed_qty  integer,          -- set for count_adjustment: the absolute count seen

  actor_user_id uuid references users(id) on delete restrict,
  note          text,
  created_at    timestamptz not null default now(),

  constraint stock_movements_kind_check
    check (kind in ('receipt', 'issue', 'return', 'count_adjustment', 'write_off'))
);

create index stock_movements_lot_idx on stock_movements (org_id, stock_lot_id, created_at desc);

-- ---------------------------------------------------------------------------
-- kit_templates — what a package is SUPPOSED to contain
--
-- A kit INSTANCE is just an asset with is_container = true; its contents are
-- containment rows. The template is separate because it is a definition, not a
-- thing.
--
-- Note templates reference PRODUCTS with a qty, so they can express bulk
-- contents (6 XLR cables) that containment cannot — and bulk contents are
-- exactly what goes missing.
-- ---------------------------------------------------------------------------
create table kit_templates (
  id          uuid primary key default uuid_generate_v7(),
  org_id      uuid not null references orgs(id) on delete restrict,
  name        text not null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index kit_templates_org_idx on kit_templates (org_id) where deleted_at is null;

create table kit_template_items (
  id              uuid primary key default uuid_generate_v7(),
  org_id          uuid not null references orgs(id) on delete restrict,
  kit_template_id uuid not null references kit_templates(id) on delete restrict,
  product_id      uuid not null references products(id) on delete restrict,
  qty             integer not null default 1,
  -- "nice to have" items do not block a pull from completing.
  required        boolean not null default true,

  constraint kit_template_items_qty_positive check (qty > 0)
);

create unique index kit_template_items_ident_idx
  on kit_template_items (kit_template_id, product_id);

-- ---------------------------------------------------------------------------
-- jobs — phase 1's answer to "who has it"
--
-- Three columns of free text, no customer entity, no validation. Bookings and
-- customers do not arrive until phase 2, and without this the phase 1 board
-- can show WHAT is out but not WHO has it — which is the entire pitch.
--
-- In phase 2 a job is upgraded to a booking by adding booking_id and
-- backfilling, rather than being thrown away.
-- ---------------------------------------------------------------------------
create table jobs (
  id             uuid primary key default uuid_generate_v7(),
  org_id         uuid not null references orgs(id) on delete restrict,

  label          text not null,          -- "Ali / Rafi Peer shoot"
  contact        text,                   -- a phone number, usually
  expected_back  date,

  status         text not null default 'open',

  created_by     uuid references users(id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint jobs_status_check check (status in ('open', 'closed', 'cancelled'))
);

create index jobs_org_status_idx on jobs (org_id, status) where deleted_at is null;
create index jobs_org_expected_idx on jobs (org_id, expected_back) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger global_products_updated_at before update on global_products for each row execute function set_updated_at();
create trigger locations_updated_at       before update on locations       for each row execute function set_updated_at();
create trigger products_updated_at        before update on products        for each row execute function set_updated_at();
create trigger assets_updated_at          before update on assets          for each row execute function set_updated_at();
create trigger asset_tags_updated_at      before update on asset_tags      for each row execute function set_updated_at();
create trigger stock_lots_updated_at      before update on stock_lots      for each row execute function set_updated_at();
create trigger kit_templates_updated_at   before update on kit_templates   for each row execute function set_updated_at();
create trigger jobs_updated_at            before update on jobs            for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Soft-delete guards
--
-- The foreign keys are ON DELETE RESTRICT, which protects against a hard
-- delete — a thing nobody ever does here. The failure that ACTUALLY happens is
-- someone setting deleted_at on a product that still has assets, at which
-- point every asset is orphaned in every way that matters while the constraint
-- reports success.
--
-- So the FKs alone are insufficient, and these triggers are the real guard.
-- ---------------------------------------------------------------------------
create or replace function guard_product_soft_delete()
returns trigger
language plpgsql
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if exists (select 1 from assets a where a.product_id = new.id and a.deleted_at is null) then
      raise exception 'cannot delete product %: it still has live assets', new.id
        using errcode = 'foreign_key_violation';
    end if;
    if exists (select 1 from stock_lots s where s.product_id = new.id and s.qty_on_hand > 0) then
      raise exception 'cannot delete product %: it still has stock on hand', new.id
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger products_soft_delete_guard
  before update on products for each row execute function guard_product_soft_delete();

create or replace function guard_location_soft_delete()
returns trigger
language plpgsql
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if exists (select 1 from assets a
               where a.current_location_id = new.id and a.deleted_at is null) then
      raise exception 'cannot delete location %: assets are still there', new.id
        using errcode = 'foreign_key_violation';
    end if;
    if exists (select 1 from locations l where l.parent_id = new.id and l.deleted_at is null) then
      raise exception 'cannot delete location %: it still has child locations', new.id
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger locations_soft_delete_guard
  before update on locations for each row execute function guard_location_soft_delete();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table locations          enable row level security;
alter table products           enable row level security;
alter table assets             enable row level security;
alter table asset_tags         enable row level security;
alter table asset_containment  enable row level security;
alter table stock_lots         enable row level security;
alter table stock_movements    enable row level security;
alter table kit_templates      enable row level security;
alter table kit_template_items enable row level security;
alter table jobs               enable row level security;
alter table global_products    enable row level security;

alter table locations          force row level security;
alter table products           force row level security;
alter table assets             force row level security;
alter table asset_tags         force row level security;
alter table asset_containment  force row level security;
alter table stock_lots         force row level security;
alter table stock_movements    force row level security;
alter table kit_templates      force row level security;
alter table kit_template_items force row level security;
alter table jobs               force row level security;
alter table global_products    force row level security;

-- Every tenant table gets the same shape. Deliberately uniform: a policy that
-- looks different from its neighbours is where a leak hides.
do $$
declare t text;
begin
  foreach t in array array[
    'locations', 'products', 'assets', 'asset_tags', 'asset_containment',
    'stock_lots', 'stock_movements', 'kit_templates', 'kit_template_items', 'jobs'
  ]
  loop
    execute format(
      'create policy %1$s_tenant on %1$s for all
         using (org_id = current_org_id())
         with check (org_id = current_org_id())', t);
  end loop;
end
$$;

-- The shared catalogue is world-readable within the app and writable only by
-- the platform (no policy grants INSERT/UPDATE to papa_app).
create policy global_products_read on global_products for select using (true);

grant select, insert, update on
  locations, products, assets, asset_tags, asset_containment,
  stock_lots, stock_movements, kit_templates, kit_template_items, jobs
  to papa_app;

grant select on global_products to papa_app;
grant execute on function generate_tag_code() to papa_app;
