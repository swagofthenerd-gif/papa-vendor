import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@papa/design/tokens.css'
import './semantic.css'
import './app.css'
import { App } from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
