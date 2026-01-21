/**
 * Shared test utilities for analysis test files.
 *
 * These utilities are used by:
 * - politician-analysis.test.ts
 * - simulation.test.ts
 * - scoring-retrospective.test.ts
 * - strategy-variations.test.ts
 */

import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Data Loading
// =============================================================================

const DB_PATH = path.join(__dirname, "../../../trader-db-export.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedData: { signals: any[] } | null = null;

/**
 * Load raw signals from the exported database file.
 * Results are cached to avoid repeated file reads across test files.
 *
 * @returns Array of signal objects (untyped - cast as needed in test files)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadSignalsFromExport(): any[] {
  if (!cachedData) {
    cachedData = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  }
  return cachedData!.signals;
}

/**
 * Calculate days between two date strings.
 */
export function daysBetween(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Annualize a return percentage based on hold period.
 */
export function annualizeReturn(returnPct: number, holdDays: number): number {
  if (holdDays <= 0) return 0;
  const r = returnPct / 100;
  const years = holdDays / 365;
  if (years < 0.1) return returnPct;
  const annualized = Math.pow(1 + r, 1 / years) - 1;
  return annualized * 100;
}
