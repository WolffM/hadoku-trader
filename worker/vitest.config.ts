import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Backtesting/simulation tests process a year+ of signals and regularly
    // run 9-12s each. The 5s default produced a flaky failure on
    // simulation.test.ts's "4 strategies × 5 filters" case.
    testTimeout: 30000,
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
})
