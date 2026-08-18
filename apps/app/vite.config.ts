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
  // sql.js ships as CommonJS, so it MUST go through Vite's dependency
  // pre-bundling to get an ESM default export. Excluding it here produces a
  // blank page and "does not provide an export named 'default'".
  build: { target: 'es2020', sourcemap: true },
})
