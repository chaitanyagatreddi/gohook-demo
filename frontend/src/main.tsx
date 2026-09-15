import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const wireframe = new URLSearchParams(window.location.search).get('wireframe')
const { default: RootComponent } = wireframe === 'ideate'
  ? await import('./IdeateWireframe.tsx')
  : wireframe === 'review'
    ? await import('./QuestionRunWireframe.tsx')
    : await import('./App.tsx')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootComponent />
  </StrictMode>,
)
