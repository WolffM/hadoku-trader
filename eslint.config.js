import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import globals from 'globals'
import prettierConfig from 'eslint-config-prettier'

// Shared TypeScript rules
const sharedTsRules = {
  // Pull in all recommended + strict TS rules
  ...js.configs.recommended.rules,
  ...tsPlugin.configs['recommended'].rules,
  ...tsPlugin.configs['recommended-type-checked'].rules,
  ...tsPlugin.configs['stylistic-type-checked'].rules,

  // -----------------------------
  //     SENSIBLE STRICT RULES
  // -----------------------------

  // Prevent sloppy code paths
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',

  // Avoid silent bugs
  '@typescript-eslint/no-unnecessary-condition': 'off', // Allow defensive null checks
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

  // Real-world strictness
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
  ],
  '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
  '@typescript-eslint/no-non-null-assertion': 'off', // Allow ! after validation checks

  // Browser correctness
  'no-restricted-globals': ['error', 'event', 'fdescribe'],

  // Safer equality
  eqeqeq: ['error', 'always'],

  // Clean imports
  'no-unused-vars': 'off',
  'no-duplicate-imports': 'error',
  'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],

  // Allow void for fire-and-forget async (cleaner than .catch(() => {}))
  'no-void': 'off',

  // Allow console logs when intentional
  'no-console': 'off',

  // Allow intentional || for empty strings and falsy values
  '@typescript-eslint/prefer-nullish-coalescing': 'off',
  '@typescript-eslint/prefer-optional-chain': 'off'
}

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/vite.config.ts',
      '**/vitest.config.ts',
      '**/test-utils.ts'
    ]
  },

  // -------------------------------------------------------------
  // Frontend (src) TypeScript + React config
  // -------------------------------------------------------------
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json'
      },
      globals: {
        // Sanitize keys to fix globals.browser bug (trailing whitespace in "AudioWorkletGlobalScope ")
        ...Object.fromEntries(
          Object.entries(globals.browser).map(([key, value]) => [key.trim(), value])
        )
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: sharedTsRules
  },

  // -------------------------------------------------------------
  // Worker TypeScript config (uses worker/tsconfig.json)
  // -------------------------------------------------------------
  {
    files: ['worker/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './worker/tsconfig.json'
      },
      globals: {
        // Cloudflare Workers globals
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
        D1Database: 'readonly',
        ScheduledEvent: 'readonly',
        ExecutionContext: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Date: 'readonly',
        JSON: 'readonly',
        Math: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        Promise: 'readonly',
        Error: 'readonly',
        Object: 'readonly',
        Array: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Boolean: 'readonly',
        Symbol: 'readonly',
        BigInt: 'readonly',
        RegExp: 'readonly',
        Uint8Array: 'readonly',
        ArrayBuffer: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        TransformStream: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      ...sharedTsRules,
      // Relax unsafe-any rules for worker code (D1 queries return any)
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off'
    }
  },

  // -------------------------------------------------------------
  // PRETTIER OVERRIDES (must be last)
  // -------------------------------------------------------------
  prettierConfig
]
