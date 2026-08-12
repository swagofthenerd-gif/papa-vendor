import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative base so a Capacitor WebView (file://) can load the bundle. The
  // sibling learned this the hard way with gh-pages; same constraint, different
  // reason.
  base: './',
  build: { target: 'es2020', sourcemap: true },
})
