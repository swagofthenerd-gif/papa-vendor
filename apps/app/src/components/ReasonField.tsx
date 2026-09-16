import { STR } from '../strings.ts'

/**
 * How the app asks WHY — one home for the prompt every override wears.
 *
 * Override 18 is the rule behind all of them: the owner's judgement is
 * never fought and always RECORDED, and several of the servers' own
 * constraints refuse a note-less decision outright. So W13's doors all ask
 * the same question — correct this line, write it off, write off the whole
 * balance, waive a fee, refuse a client — and they must ask it in the same
 * words, with the same keyboard behaviour, or the reason field reads as
 * five different fields on five screens.
 *
 * ONLY THE PLACEHOLDER CHANGES, because only the example changes: a
 * double-tapped charge and an absconded client are not the same sentence.
 * The label, the styling, and the two keyboard settings are the same
 * everywhere — autocorrect and spellcheck are OFF because the reason is
 * often Roman Urdu, names and cheque numbers, none of which an English
 * dictionary improves.
 *
 * `id` is the caller's, so every label still points at its own input on a
 * page that may hold more than one of these.
 */
export function ReasonField({
  id,
  value,
  placeholder,
  onChange,
  autoFocus = false,
}: {
  id: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  /** True where the field is the sheet's first business — the correction
   *  and the refusal open ON the question. */
  autoFocus?: boolean
}) {
  return (
    <>
      <label className="field-label" htmlFor={id}>{STR.moneyReasonLabel}</label>
      <input
        id={id}
        className="sheet-search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
      />
    </>
  )
}
