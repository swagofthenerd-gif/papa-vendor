import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

/**
 * `npm run dev`        — localhost, plain http. The camera works because
 *                        localhost counts as a secure page.
 * `npm run dev:https`  — LAN address over https with a self-signed
 *                        certificate, which is the only way a PHONE on the
 *                        same wifi can open its camera. The phone will warn
 *                        about the certificate once; that is expected.
 */
const https = process.env.PAPA_HTTPS === '1'

export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  // Relative base so a Capacitor WebView (file://) can load the bundle. The
  // sibling learned this the hard way with gh-pages; same constraint, different
  // reason.
  base: './',
  server: { host: true },
  // NOTE: sql.js ships as CommonJS and MUST go through Vite's dependency
  // pre-bundling to get an ESM default export. Putting it in
  // optimizeDeps.exclude produces a blank page.
  //
  // ASCII-only output. The single-file demo inlines this bundle into a page
  // whose charset the host controls, and a literal \u0300 inside the
  // accent-folding regex becomes an invalid character class the moment the
  // bytes are read as anything but UTF-8 — a blank page with one cryptic
  // SyntaxError.
  esbuild: { charset: 'ascii' },
  build: { target: 'es2020', sourcemap: true },
})
