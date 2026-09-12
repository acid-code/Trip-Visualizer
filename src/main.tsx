import { createRoot } from 'react-dom/client'
import App from './App'
import { startUpdateChecks } from './updateCheck'
import './index.css'

// Never let update/SW bootstrap kill the app (phone black-screen after hard reset).
try {
  startUpdateChecks()
} catch (err) {
  console.error('[update] startUpdateChecks failed', err)
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
