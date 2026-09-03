/**
 * The case sheet's "not in here" logic — the pure part.
 *
 * In a .ts module, like scan-row.ts and session-summary.ts, so it can be
 * asserted without a build step: Node strips types but cannot transform JSX.
 *
 * "Take the case as packed" used to be all-or-nothing: either scan every
 * child or take the whole manifest on trust. The tech who KNOWS the second
 * battery is not in the case had no way to say so short of scanning
 * everything else one by one — so on a busy morning they pressed the button
 * anyway, and the record swore to a battery nobody believed was there.
 *
 * A row toggled "not in here" is EXCLUDED from the bulk confirm: no op is
 * written for it at all, so it stays unrecorded and lands on the session
 * shortfall as missing — the truthful outcome for a plate somebody pulled on
 * Tuesday. The untouched rows are still recorded as `assumed`: countable,
 * visible on the manifest, and never dispute evidence.
 */

/** The children a bulk confirm would actually record: still unrecorded this
 *  session, and not marked "not in here". */
export function confirmRest(
  packed: { assetId: string }[],
  alreadyRecorded: Set<string>,
  notInHere: Set<string>,
): string[] {
  return packed
    .filter((c) => !alreadyRecorded.has(c.assetId) && !notInHere.has(c.assetId))
    .map((c) => c.assetId)
}

/**
 * Toggle one row's "not in here" mark, returning a NEW set.
 *
 * A new set rather than a mutation because the caller holds this in React
 * state — mutating in place renders nothing, and a toggle that does not
 * visibly toggle reads as a mis-tap and gets tapped again.
 */
export function toggleNotInHere(notInHere: Set<string>, assetId: string): Set<string> {
  const next = new Set(notInHere)
  if (next.has(assetId)) next.delete(assetId)
  else next.add(assetId)
  return next
}
