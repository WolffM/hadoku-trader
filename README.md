# @wolffm/trader

Stock and crypto trading dashboard for hadoku.

## Overview

A trading dashboard child app that integrates with the hadoku parent site for monitoring stocks and crypto.

## Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Build for production
pnpm build

# Lint and format
pnpm lint:fix
pnpm format
```

### Logging

**Important**: Use the logger from `@wolffm/task-ui-components` instead of `console.log`:

```typescript
import { logger } from '@wolffm/task-ui-components'

logger.info('Message', { key: 'value' })
logger.error('Error occurred', error)
```

Available methods: `logger.info()`, `logger.error()`, `logger.warn()`, `logger.debug()`

Logs are only visible in dev mode or when authenticated as admin.

## Integration

This app is a child component of the [hadoku_site](https://github.com/WolffM/hadoku_site) parent application.

### Props

```typescript
interface TraderProps {
  theme?: string // 'light', 'dark', 'coffee-dark', etc.
}
```

### Mounting

```typescript
import { mount, unmount } from '@wolffm/trader'

// Mount the app
mount(document.getElementById('app-root'), {
  theme: 'ocean-dark'
})

// Unmount when done
unmount(document.getElementById('app-root'))
```

## Deployment

Pushes to `main` automatically:

1. Build and publish to GitHub Packages
2. Notify parent site to update
3. Parent pulls new version and redeploys

## Theme Integration

Use CSS variables from `@wolffm/themes` for all colors:

```css
background-color: var(--color-bg);
color: var(--color-text);
border-color: var(--color-border);
```

Set theme attributes in your root component:

```typescript
containerRef.current?.setAttribute('data-theme', theme)
containerRef.current?.setAttribute('data-dark-theme', isDarkTheme ? 'true' : 'false')
```
