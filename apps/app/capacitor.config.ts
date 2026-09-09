import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The Android shell around the existing web app.
 *
 * webDir is the ordinary Vite output — `npm run build:app` then
 * `npx cap sync android` copies dist/ into the Android project. The Vite
 * config already sets `base: './'` for exactly this consumer.
 *
 * appId is pk.* because the product is Pakistani; it must never change after
 * the first install lands on a real phone (Android identity is the id).
 */
const config: CapacitorConfig = {
  appId: 'pk.papavendor.app',
  appName: 'Papa Vendor',
  webDir: 'dist',
  android: {
    // The scan screen punches a transparent hole for the native camera
    // preview; a null WebView background would flash white before the CSS
    // loads, so keep the default opaque background and let the native-scan
    // stylesheet make it transparent only while scanning.
    allowMixedContent: false,
  },
}

export default config
