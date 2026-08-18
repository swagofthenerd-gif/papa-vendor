/**
 * Vite's `?url` imports, declared narrowly.
 *
 * The alternative is adding "vite/client" to the root tsconfig's `types`,
 * which would pull Vite's whole ambient surface into every package including
 * `packages/core` — the one package that must stay dependency-free so its
 * tests run untranspiled under `node --test`.
 */
declare module '*.wasm?url' {
  const url: string
  export default url
}
