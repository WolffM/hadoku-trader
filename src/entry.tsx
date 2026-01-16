import { createRoot, type Root } from 'react-dom/client'
import { logger } from '@wolffm/task-ui-components'
import App from './App'
// REQUIRED: Import @wolffm/themes CSS - DO NOT REMOVE
import '@wolffm/themes/style.css'
// REQUIRED: Import theme picker CSS
import '@wolffm/task-ui-components/theme-picker.css'
import './styles/index.css'

// Props interface for configuration from parent app
export interface TraderProps {
  theme?: string // Theme passed from parent (e.g., 'default', 'ocean', 'forest')
}

// Extend HTMLElement to include __root property
interface TraderElement extends HTMLElement {
  __root?: Root
}

// Mount function - called by parent to initialize your app
export function mount(el: HTMLElement, props: TraderProps = {}) {
  const root = createRoot(el)
  root.render(<App {...props} />)
  ;(el as TraderElement).__root = root
  logger.info('[trader] Mounted successfully', { theme: props.theme })
}

// Unmount function - called by parent to cleanup your app
export function unmount(el: HTMLElement) {
  ;(el as TraderElement).__root?.unmount()
  logger.info('[trader] Unmounted successfully')
}
