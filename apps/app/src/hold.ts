/**
 * How long "press and hold" takes.
 *
 * A tap at the bottom of the screen is exactly what a knuckle does while
 * carrying a case, and an accidental finish closes a pull the tech is halfway
 * through. Long enough to be deliberate; short enough not to feel broken.
 *
 * In a .ts module so it can be asserted without a build step — see status.ts
 * for why that matters.
 */
export const HOLD_MS = 500
