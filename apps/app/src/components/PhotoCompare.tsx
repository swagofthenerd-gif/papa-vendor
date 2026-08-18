import { Icon } from '@papa/icons'
import type { PhotoPair, PhotoRow } from '@papa/core'

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
        <p>No condition photos yet.</p>
        <p className="muted">
          Photograph an item on the way out and again on the way back, and the two
          sit side by side here.
        </p>
      </div>
    )
  }

  return (
    <ul className="compare-list">
      {pairs.map((pair, i) => (
        <li key={pair.out?.id ?? pair.in?.id ?? i} className="compare">
          <div className="compare-grid">
            <Half photo={pair.out} label="Going out" missing="No photo going out" />
            <Half photo={pair.in} label="Coming back" missing="Not photographed back yet" />
          </div>
          {pair.out && !pair.in ? (
            <p className="compare-note">
              This went out with a photo and has no matching one coming back.
            </p>
          ) : null}
          {!pair.out && pair.in ? (
            <p className="compare-note">
              Photographed on return only — there is nothing to compare it against.
            </p>
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
          <img className="compare-img" src={photo.localUri} alt={`${label} condition photo`} />
          <p className="compare-meta">
            {new Date(photo.capturedAt).toLocaleString()}
            {/* Never presented as a fact. Until the server stamps its own time
                on arrival, the only timestamp is the one the phone chose. */}
            <span className="compare-clock"> · by this phone’s clock</span>
          </p>
          {photo.uploaded ? null : (
            <p className="compare-meta compare-pending">
              <Icon name="cloud-queue" size={12} /> only on this phone
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
