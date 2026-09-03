import { Icon } from '@papa/icons'
import type { PhotoPair, PhotoRow } from '@papa/core'
import { STR } from '../strings.ts'

/**
 * Out beside in — the argument-settling screen.
 *
 * SIDE BY SIDE, SAME SIZE, NO EFFECTS. No slider, no fade, no zoom toy. The
 * person looking at this is usually a client being asked to pay for a scratch,
 * and any interaction that changes what is on screen invites the reply "you
 * are showing me a trick". Two photographs, both the same size, both labelled.
 *
 * THE GAP IS A FINDING, NOT AN EMPTY SLOT. "Went out, no photo coming back"
 * is stated in words, because that is the case where the house cannot claim
 * and the owner needs to know it before the conversation, not during it.
 */
export function PhotoCompare({ pairs }: { pairs: PhotoPair[] }) {
  if (pairs.length === 0) {
    return (
      <div className="empty">
        <Icon name="camera" size={32} />
        <p>{STR.gearNoConditionPhotosYet}</p>
        <p className="muted">{STR.gearPhotographOutAndBack}</p>
      </div>
    )
  }

  return (
    <ul className="compare-list">
      {pairs.map((pair, i) => (
        <li key={pair.out?.id ?? pair.in?.id ?? i} className="compare">
          <div className="compare-grid">
            <Half photo={pair.out} label={STR.gearGoingOutLabel} missing={STR.gearNoPhotoGoingOut} />
            <Half photo={pair.in} label={STR.gearComingBackLabel} missing={STR.gearNotPhotographedBackYet} />
          </div>
          {pair.out && !pair.in ? (
            <p className="compare-note">{STR.gearWentOutNoMatchingPhoto}</p>
          ) : null}
          {!pair.out && pair.in ? (
            <p className="compare-note">{STR.gearPhotographedOnReturnOnly}</p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function Half({
  photo,
  label,
  missing,
}: {
  photo: PhotoRow | null
  label: string
  missing: string
}) {
  return (
    <figure className="compare-half">
      <figcaption className="compare-label">{label}</figcaption>
      {photo ? (
        <>
          <img className="compare-img" src={photo.localUri} alt={STR.gearConditionPhotoAlt(label)} />
          <p className="compare-meta">
            {new Date(photo.capturedAt).toLocaleString()}
            {/* Never presented as a fact. Until the server stamps its own time
                on arrival, the only timestamp is the one the phone chose. */}
            <span className="compare-clock"> · {STR.gearByThisPhonesClock}</span>
          </p>
          {photo.uploaded ? null : (
            <p className="compare-meta compare-pending">
              <Icon name="cloud-queue" size={12} /> {STR.gearOnlyOnThisPhone}
            </p>
          )}
        </>
      ) : (
        <div className="compare-gap">
          <Icon name="camera" size={22} />
          <span>{missing}</span>
        </div>
      )}
    </figure>
  )
}
