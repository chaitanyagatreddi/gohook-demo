import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import NewVersionBar from './NewVersionBar.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <NewVersionBar />
  </StrictMode>,
)
