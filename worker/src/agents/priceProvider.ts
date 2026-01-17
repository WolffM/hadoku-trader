/**
 * Price Provider for Simulation
 * Generates mock historical prices for backtesting
 */

import type { SignalForSim } from "./simulation";
import { addDays } from "./simulation";

// =============================================================================
// Price Provider Interface
// =============================================================================

/**
 * Synchronous price provider interface for mock/static providers.
 */
export interface PriceProvider {
  getPrice(ticker: string, date: string): number | null;
  getClosingPrices(tickers: string[], date: string): Map<string, number>;
}

/**
 * Async price provider interface for database-backed providers.
 */
export interface AsyncPriceProvider {
  getPrice(ticker: string, date: string): Promise<number | null>;
  getClosingPrices(tickers: string[], date: string): Promise<Map<string, number>>;
  getOHLC(ticker: string, date: string): Promise<OHLC | null>;
}

/**
 * OHLC price data structure.
 */
export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Market price row from database.
 */
export interface MarketPriceRow {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
}

// =============================================================================
// Mock Price Provider
// =============================================================================

/**
 * Generates realistic mock price data using random walk from disclosed prices.
 * Prices are deterministic based on seed for reproducibility.
 */
export class MockPriceProvider implements PriceProvider {
  private priceCache: Map<string, Map<string, number>> = new Map();
  private seed: number;
  private daysToGenerate: number;

  /**
   * @param signals - Signals to base prices on
   * @param seed - Random seed for reproducibility (default: 42)
   * @param daysToGenerate - Days of price data to generate forward (default: 150)
   */
  constructor(
    signals: SignalForSim[],
    seed: number = 42,
    daysToGenerate: number = 150
  ) {
    this.seed = seed;
    this.daysToGenerate = daysToGenerate;
    this.initializePrices(signals);
  }

  /**
   * Seeded random number generator for reproducibility.
   */
  private seededRandom(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return (this.seed % 10000) / 10000;
  }

  /**
   * Generate price paths from each signal's disclosed price.
   */
  private initializePrices(signals: SignalForSim[]): void {
    // Track unique tickers with their earliest disclosed date and price
    const tickerInfo = new Map<
      string,
      { date: string; price: number }
    >();

    // Find earliest disclosed date and price for each ticker
    for (const signal of signals) {
      const existing = tickerInfo.get(signal.ticker);
      if (!existing || signal.disclosed_date < existing.date) {
        tickerInfo.set(signal.ticker, {
          date: signal.disclosed_date,
          price: signal.disclosed_price || 100,
        });
      }
    }

    // Generate price paths for each ticker
    for (const [ticker, info] of tickerInfo) {
      this.generatePricePath(ticker, info.date, info.price);
    }
  }

  /**
   * Generate a random walk price path for a ticker.
   */
  private generatePricePath(
    ticker: string,
    startDate: string,
    basePrice: number
  ): void {
    const tickerPrices = new Map<string, number>();
    let price = basePrice;

    // Generate prices for each day
    for (let i = 0; i < this.daysToGenerate; i++) {
      const date = addDays(startDate, i);

      // Random walk: daily change of ±3%
      // Using normal distribution approximation (Box-Muller)
      const u1 = this.seededRandom();
      const u2 = this.seededRandom();
      const z = Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);

      // Daily volatility ~1.5%, with slight upward drift
      const dailyReturn = 0.0003 + z * 0.015;
      price *= 1 + dailyReturn;

      // Ensure price doesn't go negative
      price = Math.max(price, 0.01);

      tickerPrices.set(date, Number(price.toFixed(2)));
    }

    this.priceCache.set(ticker, tickerPrices);
  }

  /**
   * Get price for a ticker on a specific date.
   */
  getPrice(ticker: string, date: string): number | null {
    const tickerPrices = this.priceCache.get(ticker);
    if (!tickerPrices) {
      return null;
    }

    const price = tickerPrices.get(date);
    if (price !== undefined) {
      return price;
    }

    // If exact date not found, try to find nearest available date
    const sortedDates = Array.from(tickerPrices.keys()).sort();
    const nearestDate = sortedDates.find((d) => d >= date);
    if (nearestDate) {
      return tickerPrices.get(nearestDate) ?? null;
    }

    // Return last available price if date is after our data
    const lastDate = sortedDates[sortedDates.length - 1];
    return tickerPrices.get(lastDate) ?? null;
  }

  /**
   * Get closing prices for multiple tickers on a date.
   */
  getClosingPrices(tickers: string[], date: string): Map<string, number> {
    const prices = new Map<string, number>();

    for (const ticker of tickers) {
      const price = this.getPrice(ticker, date);
      if (price !== null) {
        prices.set(ticker, price);
      }
    }

    return prices;
  }

  /**
   * Check if we have price data for a ticker.
   */
  hasTicker(ticker: string): boolean {
    return this.priceCache.has(ticker);
  }

  /**
   * Get all tickers with price data.
   */
  getTickers(): string[] {
    return Array.from(this.priceCache.keys());
  }

  /**
   * Get price range for a ticker.
   */
  getDateRange(ticker: string): { start: string; end: string } | null {
    const tickerPrices = this.priceCache.get(ticker);
    if (!tickerPrices || tickerPrices.size === 0) {
      return null;
    }

    const dates = Array.from(tickerPrices.keys()).sort();
    return {
      start: dates[0],
      end: dates[dates.length - 1],
    };
  }

  /**
   * Calculate price change percentage between two dates.
   */
  getPriceChange(
    ticker: string,
    startDate: string,
    endDate: string
  ): number | null {
    const startPrice = this.getPrice(ticker, startDate);
    const endPrice = this.getPrice(ticker, endDate);

    if (startPrice === null || endPrice === null) {
      return null;
    }

    return ((endPrice - startPrice) / startPrice) * 100;
  }
}

// =============================================================================
// Static Price Provider (for testing with fixed prices)
// =============================================================================

/**
 * Simple price provider with predetermined prices.
 * Useful for unit testing.
 */
export class StaticPriceProvider implements PriceProvider {
  private prices: Map<string, Map<string, number>> = new Map();

  /**
   * Set a price for a ticker on a date.
   */
  setPrice(ticker: string, date: string, price: number): void {
    if (!this.prices.has(ticker)) {
      this.prices.set(ticker, new Map());
    }
    this.prices.get(ticker)!.set(date, price);
  }

  /**
   * Set a constant price for all dates.
   */
  setConstantPrice(ticker: string, price: number): void {
    if (!this.prices.has(ticker)) {
      this.prices.set(ticker, new Map());
    }
    // Use special key for constant prices
    this.prices.get(ticker)!.set("*", price);
  }

  getPrice(ticker: string, date: string): number | null {
    const tickerPrices = this.prices.get(ticker);
    if (!tickerPrices) {
      return null;
    }

    // Check for exact date match
    if (tickerPrices.has(date)) {
      return tickerPrices.get(date)!;
    }

    // Check for constant price
    if (tickerPrices.has("*")) {
      return tickerPrices.get("*")!;
    }

    return null;
  }

  getClosingPrices(tickers: string[], date: string): Map<string, number> {
    const prices = new Map<string, number>();

    for (const ticker of tickers) {
      const price = this.getPrice(ticker, date);
      if (price !== null) {
        prices.set(ticker, price);
      }
    }

    return prices;
  }
}

// =============================================================================
// D1 Price Provider (Real Historical Data)
// =============================================================================

/**
 * Database-backed price provider using D1.
 * Fetches real historical prices from the market_prices table.
 */
export class D1PriceProvider implements AsyncPriceProvider {
  private db: D1Database;
  private cache: Map<string, number> = new Map();

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Get closing price for a ticker on a specific date.
   */
  async getPrice(ticker: string, date: string): Promise<number | null> {
    const cacheKey = `${ticker}:${date}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const row = await this.db
      .prepare(`SELECT close FROM market_prices WHERE ticker = ? AND date = ?`)
      .bind(ticker, date)
      .first();

    if (row?.close !== undefined) {
      const price = row.close as number;
      this.cache.set(cacheKey, price);
      return price;
    }

    // Try to find nearest previous date if exact match not found
    const nearestRow = await this.db
      .prepare(
        `SELECT close FROM market_prices
         WHERE ticker = ? AND date <= ?
         ORDER BY date DESC LIMIT 1`
      )
      .bind(ticker, date)
      .first();

    if (nearestRow?.close !== undefined) {
      const price = nearestRow.close as number;
      this.cache.set(cacheKey, price);
      return price;
    }

    return null;
  }

  /**
   * Get closing prices for multiple tickers on a date.
   */
  async getClosingPrices(
    tickers: string[],
    date: string
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    if (tickers.length === 0) {
      return prices;
    }

    // Build query with placeholders
    const placeholders = tickers.map(() => "?").join(",");
    const results = await this.db
      .prepare(
        `SELECT ticker, close FROM market_prices
         WHERE ticker IN (${placeholders}) AND date = ?`
      )
      .bind(...tickers, date)
      .all();

    for (const row of results.results) {
      const ticker = row.ticker as string;
      const close = row.close as number;
      prices.set(ticker, close);
      this.cache.set(`${ticker}:${date}`, close);
    }

    // For tickers not found on exact date, try nearest previous
    for (const ticker of tickers) {
      if (!prices.has(ticker)) {
        const price = await this.getPrice(ticker, date);
        if (price !== null) {
          prices.set(ticker, price);
        }
      }
    }

    return prices;
  }

  /**
   * Get full OHLC data for a ticker on a date.
   */
  async getOHLC(ticker: string, date: string): Promise<OHLC | null> {
    const row = await this.db
      .prepare(
        `SELECT open, high, low, close, volume
         FROM market_prices WHERE ticker = ? AND date = ?`
      )
      .bind(ticker, date)
      .first();

    if (!row) {
      return null;
    }

    return {
      open: row.open as number,
      high: row.high as number,
      low: row.low as number,
      close: row.close as number,
      volume: row.volume as number | undefined,
    };
  }

  /**
   * Get date range available for a ticker.
   */
  async getDateRange(
    ticker: string
  ): Promise<{ start: string; end: string } | null> {
    const row = await this.db
      .prepare(
        `SELECT MIN(date) as start_date, MAX(date) as end_date
         FROM market_prices WHERE ticker = ?`
      )
      .bind(ticker)
      .first();

    if (!row?.start_date) {
      return null;
    }

    return {
      start: row.start_date as string,
      end: row.end_date as string,
    };
  }

  /**
   * Get all unique tickers in the database.
   */
  async getTickers(): Promise<string[]> {
    const results = await this.db
      .prepare(`SELECT DISTINCT ticker FROM market_prices ORDER BY ticker`)
      .all();

    return results.results.map((row) => row.ticker as string);
  }

  /**
   * Get price count in the database.
   */
  async getPriceCount(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as count FROM market_prices`)
      .first();

    return (row?.count as number) ?? 0;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}
