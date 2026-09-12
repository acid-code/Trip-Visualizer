import { createRoot } from 'react-dom/client'
import App from './App'
import { startUpdateChecks } from './updateCheck'
import './index.css'

startUpdateChecks()
createRoot(document.getElementById('root')!).render(<App />)
