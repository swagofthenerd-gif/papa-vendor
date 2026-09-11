import { Icon } from '@papa/icons'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { go } from '../nav.ts'
import { BackedUpRow, LanguageRow, PaymentRow, Tags } from './Tags.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Settings — the desk-side knobs, reached from the gear glyph in every
 * tab's top bar rather than from a tab of their own. Four tabs is the
 * Shell's own rule, and none of these is a PLACE the day happens in: the
 * language is chosen once, the payment line once, the labels printed once
 * a rack. The label sheet keeps its own subsection at the bottom, print
 * button first, because it is the one thing here that is used again.
 */
export function SettingsScreen({ store }: { store: DemoStore }) {
  return (
    <Shell
      view={{ name: 'settings' }}
      title={STR.commonSettings}
      subtitle={STR.commonSettingsSubtitle}
      action={
        <button className="icon-btn" onClick={() => history.back()} aria-label={STR.commonClose}>
          <Icon name="x" size={22} />
        </button>
      }
    >
      <LanguageRow />
      <BackedUpRow store={store} />
      <PaymentRow store={store} />

      <section className="tag-shelf">
        <h2 className="tag-shelf-name">{STR.labelsLoadYourGear}</h2>
        <button className="btn btn-outline btn-block" onClick={() => go({ name: 'import' })}>
          <Icon name="scroll" size={18} /> {STR.labelsImportDoor}
        </button>
      </section>

      <section className="section">
        <SectionHead
          icon="ticket"
          title={STR.labelsTitle}
          sub={STR.labelsSubtitle(store.seed.tags.length)}
        />
        <Tags store={store} />
      </section>
    </Shell>
  )
}
