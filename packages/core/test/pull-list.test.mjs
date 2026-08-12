/**
 * The pull list and the feedback vocabulary.
 *
 * Both exist to make the scan loop survivable by a person who is not looking
 * at the screen and is carrying something heavy.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { buildPullList, progressSummary } from '../src/pull-list.ts'
import { FEEDBACK, ERROR_FEEDBACK, firstBuzzMs, hapticDurationMs } from '../src/feedback.ts'

const ORG = 'org-1'
let db

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(`insert into products (id, org_id, display_name) values ('p1', '${ORG}', 'Sony FX9')`)

  // Deliberately created out of walking order, so the sort has to do real work.
  const locations = [
    ['L3', 'Shelf 3', 'Warehouse / Rack B / Shelf 3'],
    ['L1', 'Rack A', 'Warehouse / Rack A'],
    ['L2', 'Rack B', 'Warehouse / Rack B'],
    ['L10', 'Rack J', 'Warehouse / Rack J'],
  ]
  for (const [id, name, path] of locations) {
    db.exec(`insert into locations (id, org_id, name, kind, path) values (?, ?, ?, 'rack', ?)`,
      [id, ORG, name, path])
  }

  const assets = [
    ['a1', 'FX9-02', 'L1'], ['a2', 'FX9-05', 'L1'],
    ['a3', 'LNS-11', 'L2'], ['a4', 'LNS-03', 'L2'], ['a5', 'LNS-07', 'L2'],
    ['a6', 'BAT-07', 'L3'],
    ['a7', 'TRI-01', 'L10'],
    ['a8', 'MYS-01', null],
  ]
  for (const [id, code, loc] of assets) {
    db.exec(
      `insert into assets (id, org_id, product_id, asset_code, current_location_id)
       values (?, ?, 'p1', ?, ?)`,
      [id, ORG, code, loc],
    )
  }
})

const ALL = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']

describe('the pull list groups by shelf', () => {
  test('so the tech walks the warehouse once', () => {
    const view = buildPullList(db, ALL, [])
    const named = view.groups.map((g) => g.locationName)
    assert.ok(named.includes('Rack A') && named.includes('Rack B'))
    assert.equal(view.total, 8)
  })

  test('ordered by location path, numerically', () => {
    // "Rack J" must not sort before "Rack B" just because J < B is false —
    // and Rack 10 must not sort before Rack 2 as a string.
    const paths = buildPullList(db, ALL, []).groups
      .filter((g) => g.locationId !== null)
      .map((g) => g.locationName)
    assert.deepEqual(paths, ['Rack A', 'Rack B', 'Shelf 3', 'Rack J'])
  })

  test('items within a shelf go in code order, the way they are labelled', () => {
    const rackB = buildPullList(db, ALL, []).groups.find((g) => g.locationName === 'Rack B')
    assert.deepEqual(rackB.items.map((i) => i.assetCode), ['LNS-03', 'LNS-07', 'LNS-11'])
  })

  test('unknown-location items sink to the bottom', () => {
    // They need searching, not walking. Mixed into the route they send the
    // tech to a shelf that will not have them.
    const groups = buildPullList(db, ALL, []).groups
    assert.equal(groups.at(-1).locationId, null)
  })

  test('an expected asset the device has never synced still appears', () => {
    // Otherwise the count is wrong and the tech hunts for something the list
    // insists does not exist.
    const view = buildPullList(db, [...ALL, 'never-synced'], [])
    assert.equal(view.total, 9)
    assert.ok(view.outstanding.some((i) => i.assetId === 'never-synced'))
  })
})

describe('progress', () => {
  test('counts what has been scanned', () => {
    const view = buildPullList(db, ALL, ['a1', 'a3'])
    assert.equal(view.scanned, 2)
    assert.equal(view.outstanding.length, 6)
    assert.equal(view.complete, false)
  })

  test('a cleared shelf sinks below shelves with work left', () => {
    // No reason to walk back to a rack you have finished, and it costs a line
    // of screen on a six-inch phone.
    const view = buildPullList(db, ALL, ['a1', 'a2'])
    const rackA = view.groups.findIndex((g) => g.locationName === 'Rack A')
    const rackB = view.groups.findIndex((g) => g.locationName === 'Rack B')
    assert.ok(rackA > rackB, 'the finished shelf moved down')
    assert.equal(view.groups[rackA].remaining, 0)
  })

  test('outstanding stays in walking order', () => {
    const view = buildPullList(db, ALL, ['a1'])
    assert.equal(view.outstanding[0].assetCode, 'FX9-05', 'finish the shelf you are standing at')
  })

  test('reports complete only when everything is in', () => {
    assert.equal(buildPullList(db, ALL, ALL).complete, true)
    assert.equal(buildPullList(db, ALL, ALL.slice(1)).complete, false)
  })

  test('the summary names PLACES, not just a number', () => {
    // "six left" is not actionable. "Rack B 3 left" is a place to walk to.
    const summary = progressSummary(buildPullList(db, ALL, ['a1', 'a2']))
    assert.match(summary, /Rack B/)
    assert.match(summary, /clear/, 'and says which shelves are done')
  })

  test('the summary says so when nothing is outstanding', () => {
    assert.equal(progressSummary(buildPullList(db, ALL, ALL)), 'All accounted for')
  })

  test('an empty list is trivially complete', () => {
    const view = buildPullList(db, [], [])
    assert.equal(view.complete, true)
    assert.equal(view.total, 0)
  })
})

describe('the feedback vocabulary', () => {
  const outcomes = ['accepted', 'duplicate', 'unexpected', 'unknown_tag', 'conflict', 'complete']

  test('every outcome has a pattern', () => {
    for (const o of outcomes) assert.ok(FEEDBACK[o], `${o} has no feedback`)
  })

  test('every outcome fires BOTH haptic and audio', () => {
    // Haptics alone fail — phones live on lanyards, not against skin. Audio
    // alone fails — warehouses run generators.
    for (const o of outcomes) {
      const spec = FEEDBACK[o]
      assert.ok(spec.haptic.length > 0, `${o} has no haptic`)
      assert.ok(spec.tones.length > 0 || spec.glide, `${o} has no audio`)
    }
  })

  test('a duplicate is NEVER silent', () => {
    // Silence is indistinguishable from "the camera didn't see it". The tech
    // rescans, gets nothing, and concludes the scanner is broken — which is
    // exactly how the system dies.
    const dup = FEEDBACK.duplicate
    assert.ok(dup.haptic.length > 0 && dup.tones.length > 0)
    assert.equal(dup.counts, false, 'but it must not advance the count')
    assert.equal(dup.visual, 'pulse-existing', 'it points at the row already there')
  })

  test('every haptic pattern is distinguishable by feel', () => {
    // The real bar is "operable with the screen face-down", which means no two
    // patterns may be identical. This caught `unexpected` and `unknown_tag`
    // sharing one pattern, which would leave a tech unable to tell "decide
    // about this later" from "ignore this".
    const shapes = outcomes.map((o) => FEEDBACK[o].haptic.join(','))
    assert.equal(new Set(shapes).size, shapes.length, `patterns collide: ${shapes.join(' | ')}`)
  })

  test('the two amber outcomes are told apart by feel AND by ear', () => {
    // Both annotate without counting, but the follow-up differs: an
    // unexpected item needs a decision, an unknown tag resolves itself.
    assert.notDeepEqual(FEEDBACK.unexpected.haptic, FEEDBACK.unknown_tag.haptic)
    assert.notEqual(Boolean(FEEDBACK.unexpected.glide), Boolean(FEEDBACK.unknown_tag.glide))
  })

  test('conflict is the most insistent pattern in the set', () => {
    // It is the one that must be noticed while the truck is in the yard.
    const conflict = hapticDurationMs(FEEDBACK.conflict)
    for (const o of ['accepted', 'duplicate', 'unexpected', 'unknown_tag']) {
      assert.ok(conflict > hapticDurationMs(FEEDBACK[o]), `conflict must out-buzz ${o}`)
    }
  })

  test('the first buzz is short enough to feel instant', () => {
    // Only the onset has to be immediate; the rest may trail. A long first
    // buzz reads as lag even when the decode was fast.
    assert.ok(firstBuzzMs(FEEDBACK.accepted) <= 30, 'the common case must feel like a tick')
  })

  test('only accepted and conflict advance the count', () => {
    // An unexpected item is on the truck but not on this job; counting it
    // would report a pull as complete when it is not.
    assert.equal(FEEDBACK.accepted.counts, true)
    assert.equal(FEEDBACK.conflict.counts, true, 'it IS going out, warning or not')
    assert.equal(FEEDBACK.unexpected.counts, false)
    assert.equal(FEEDBACK.unknown_tag.counts, false)
  })

  test('wrong outcomes fall in pitch, and completion rises', () => {
    // Pitch direction is the part people read correctly under noise.
    assert.ok(FEEDBACK.unexpected.glide.from > FEEDBACK.unexpected.glide.to)
    const tones = FEEDBACK.complete.tones.map(([hz]) => hz)
    assert.deepEqual([...tones].sort((a, b) => a - b), tones, 'completion is the only rising sound')
  })

  test('a hard error is lower and longer than any scan outcome', () => {
    assert.ok(ERROR_FEEDBACK.tones[0][0] < FEEDBACK.conflict.tones[0][0])
    assert.ok(hapticDurationMs(ERROR_FEEDBACK) >= firstBuzzMs(FEEDBACK.accepted))
  })
})
