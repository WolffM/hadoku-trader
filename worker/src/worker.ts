/**
 * Standalone worker entry point for local development.
 *
 * For production, import createTraderHandler into hadoku-site instead.
 */

import type { TraderEnv } from './types'
import { createTraderHandler } from './handler'
import { createScheduledHandler } from './scheduled'

// Re-map for backwards compatibility with wrangler.toml using DB binding
interface DevEnv extends Omit<TraderEnv, 'TRADER_DB'> {
  DB: D1Database
  TRADER_DB?: D1Database
}

function getEnv(env: DevEnv): TraderEnv {
  return {
    ...env,
    TRADER_DB: env.TRADER_DB || env.DB
  } as TraderEnv
}

export default {
  async fetch(request: Request, env: DevEnv): Promise<Response> {
    const handler = createTraderHandler(getEnv(env))
    return handler(request)
  },

  async scheduled(event: ScheduledEvent, env: DevEnv): Promise<void> {
    const handler = createScheduledHandler(getEnv(env))
    await handler(event.cron)
  }
}
