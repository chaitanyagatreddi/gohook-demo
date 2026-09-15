import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const isIdeateWireframe = new URLSearchParams(window.location.search).get('wireframe') === 'ideate'
const { default: RootComponent } = isIdeateWireframe
  ? await import('./IdeateWireframe.tsx')
  : await import('./App.tsx')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootComponent />
  </StrictMode>,
)
