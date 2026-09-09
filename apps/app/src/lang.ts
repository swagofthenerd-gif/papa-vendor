/**
 * Which language the chrome speaks.
 *
 * ONE KEY, TWO VALUES. 'papa-lang' in localStorage is either 'ur' or absent —
 * anything else (including a value a future build no longer understands) reads
 * as English, because a scanner that boots into an unreadable state over a
 * corrupt preference is worse than one that forgets a choice.
 *
 * WHY A RELOAD, NOT STATE. Twenty-three files import STR as a plain object and
 * read it at module scope (the Shell's tab array, document titles). Threading
 * a context through all of them buys a flicker-free switch nobody asked for at
 * the price of touching every screen. Language changes once, at setup, at the
 * desk — a reload is honest and costs one second. strings.ts picks the table
 * at module load from getLang(); setLang() persists and reloads so the whole
 * app re-evaluates with the other table.
 *
 * The guards exist because this module is also imported under plain Node by
 * the test suite, where localStorage and location do not exist, and inside the
 * Capacitor WebView, where storage access can throw under strict privacy
 * settings.
 */

export type Lang = 'en' | 'ur'

const KEY = 'papa-lang'

export function getLang(): Lang {
  try {
    if (typeof localStorage === 'undefined') return 'en'
    return localStorage.getItem(KEY) === 'ur' ? 'ur' : 'en'
  } catch {
    return 'en'
  }
}

/** Persist the choice and reload so every module re-reads the table. */
export function setLang(lang: Lang): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, lang)
  } catch {
    // Storage refused the write: the reload below still switches this boot;
    // the choice just will not survive a restart.
  }
  if (typeof location !== 'undefined') location.reload()
}
