import type { SqlDriver } from './db/driver.ts'

/**
 * Scanning a case.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE — override #1 in the plan, and the one
 * correctness decision the whole product's honesty rests on:
 *
 *   A case scan may record its PERMANENT children automatically.
 *   It may NEVER record its PACKED children automatically.
 *
 * `permanent` means welded — an FX9 handle cannot leave without the body, so
 * recording it alongside is a description of physics.
 *
 * `packed` means "we believe this is in there". Turning that belief into a
 * recorded fact, with a timestamp and a person's name against it, FABRICATES
 * EVIDENCE. The failure is concrete: a battery plate is pulled out on Tuesday
 * and never scanned back into the case. On Friday the case goes out. The
 * system then states, with total confidence and a named actor, that today's
 * client took that plate — and uses it against them when it does not come
 * back. They are right and the database is lying.
 *
 * So a packed child produces an UNCONFIRMED ROW that a person must act on.
 * They can scan it properly, or bulk-confirm the lot as `assumed` — which is
 * countable, visible on the manifest, and excluded from dispute evidence.
 * ---------------------------------------------------------------------------
 */

export type ContainmentKind = 'permanent' | 'packed' | 'subrented'

export interface ContainedChild {
  assetId: string
  assetCode: string | null
  displayName: string | null
  kind: ContainmentKind
  /** Where the projection currently believes this child is. */
  presence: string
}

export interface CaseManifest {
  parentId: string
  parentName: string | null
  /** Moves with the parent as a matter of physics. Recorded automatically. */
  permanent: ContainedChild[]
  /** Believed to be inside. NEVER recorded without a person. */
  packed: ContainedChild[]
  /** Believed to be inside AND belongs to someone else. Same rule as packed —
   *  never recorded without a person — but kept apart because a dispute over
   *  a subrented item is a dispute with a SUPPLIER, not a client, and a
   *  manifest that files it under "ours, believed inside" hides that. */
  subrented: ContainedChild[]
}

/** Everything one case claims to contain, split by how much that claim is worth. */
export function caseManifest(db: SqlDriver, parentId: string): CaseManifest | null {
  const parent = db.get<{ display_name: string | null; is_container: number }>(
    `select coalesce(p.display_name, a.display_name) as display_name, a.is_container
       from assets a left join products p on p.id = a.product_id
      where a.id = ?`,
    [parentId],
  )
  if (!parent) return null

  const rows = db.all<{
    child_asset_id: string
    kind: string
    asset_code: string | null
    display_name: string | null
    presence: string
  }>(
    `select c.child_asset_id, c.kind, a.asset_code,
            coalesce(p.display_name, a.display_name) as display_name, a.presence
       from asset_containment c
       join assets a on a.id = c.child_asset_id
       left join products p on p.id = a.product_id
      where c.parent_asset_id = ? and c.removed_at is null
      order by a.asset_code`,
    [parentId],
  )

  // Every relation is carried through as itself. 'subrented' used to be
  // coerced to 'packed' here, which silently laundered a supplier's gear
  // into "ours, believed inside". Anything genuinely unknown — a relation a
  // newer server ships before this build knows it — degrades to 'packed',
  // the weakest claim: believed inside, never recorded without a person.
  const children: ContainedChild[] = rows.map((r) => ({
    assetId: r.child_asset_id,
    assetCode: r.asset_code,
    displayName: r.display_name,
    kind: r.kind === 'permanent' || r.kind === 'subrented' ? r.kind : 'packed',
    presence: r.presence,
  }))

  return {
    parentId,
    parentName: parent.display_name,
    permanent: children.filter((c) => c.kind === 'permanent'),
    packed: children.filter((c) => c.kind === 'packed'),
    subrented: children.filter((c) => c.kind === 'subrented'),
  }
}

/** Whether this asset is worth opening a manifest for at all. */
export function hasContents(db: SqlDriver, assetId: string): boolean {
  // Same filter as the manifest itself, or a case emptied by removals would
  // open a manifest with nothing on it. A removed row is history, not
  // contents — a manifest still listing Tuesday's pulled plate invites the
  // tech to confirm, with their name on it, gear that is not there.
  const row = db.get<{ n: number }>(
    `select count(*) as n from asset_containment
      where parent_asset_id = ? and removed_at is null`,
    [assetId],
  )
  return Number(row?.n ?? 0) > 0
}
