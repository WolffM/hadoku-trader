/**
 * Standalone worker entry point for local development.
 *
 * For production, import createTraderHandler into hadoku-site instead.
 * trader-api has no registered CF crons — orchestration flows through
 * monitoring-api → mgmt-api → HTTP routes on this worker.
 */

import type { TraderEnv } from './types'
import { createTraderHandler } from './handler'

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
  }
}
