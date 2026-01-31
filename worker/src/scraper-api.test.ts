/**
 * Tests that validate the scraper API response format.
 *
 * These tests call the real scraper API to ensure the response format
 * matches what trader-worker expects. Run with:
 *
 *   SCRAPER_URL=https://scraper.hadoku.me SCRAPER_API_KEY=xxx pnpm test scraper-api.test.ts
 *
 * Skip in CI by checking for env vars.
 */

import { describe, it, expect } from "vitest";
import type { components } from "./generated/scraper-api";

// Use generated type from scraper OpenAPI
type ScraperSignalsResponse = components["schemas"]["FetchSignalsResponse"];

const SCRAPER_URL = process.env.SCRAPER_URL;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

const describeIfEnv = SCRAPER_URL && SCRAPER_API_KEY ? describe : describe.skip;

describeIfEnv("Scraper API Integration", () => {
  it("GET /api/v1/politrades/signals returns expected format", async () => {
    const resp = await fetch(`${SCRAPER_URL}/api/v1/politrades/signals?limit=5`, {
      headers: {
        Authorization: `Bearer ${SCRAPER_API_KEY}`,
        Accept: "application/json",
      },
    });

    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);

    const data: ScraperSignalsResponse = await resp.json();

    // Validate top-level structure
    expect(data).toHaveProperty("signals");
    expect(data).toHaveProperty("sources_fetched");
    expect(data).toHaveProperty("sources_failed");
    expect(data).toHaveProperty("total_signals");
    expect(data).toHaveProperty("fetched_at");

    // Validate types
    expect(Array.isArray(data.signals)).toBe(true);
    expect(Array.isArray(data.sources_fetched)).toBe(true);
    expect(typeof data.sources_failed).toBe("object");
    expect(typeof data.total_signals).toBe("number");
    expect(typeof data.fetched_at).toBe("string");

    // Validate signal count matches
    expect(data.signals.length).toBeLessThanOrEqual(5);
    expect(data.total_signals).toBe(data.signals.length);

    // Validate signal structure if we have any
    if (data.signals.length > 0) {
      const signal = data.signals[0];

      // Required top-level fields
      expect(signal).toHaveProperty("source");
      expect(signal).toHaveProperty("politician");
      expect(signal).toHaveProperty("trade");
      expect(signal).toHaveProperty("meta");

      // Politician fields
      expect(signal.politician).toHaveProperty("name");
      expect(signal.politician).toHaveProperty("chamber");
      expect(signal.politician).toHaveProperty("party");
      expect(signal.politician).toHaveProperty("state");

      // Trade fields
      expect(signal.trade).toHaveProperty("action");
      expect(signal.trade).toHaveProperty("trade_date");
      expect(signal.trade).toHaveProperty("disclosure_date");

      // Meta fields
      expect(signal.meta).toHaveProperty("source_id");
      expect(signal.meta).toHaveProperty("scraped_at");
    }

    console.log(`✓ Validated ${data.total_signals} signals from ${data.sources_fetched.join(", ")}`);
  });

  it("should NOT have legacy fields (success, data, count)", async () => {
    const resp = await fetch(`${SCRAPER_URL}/api/v1/politrades/signals?limit=1`, {
      headers: {
        Authorization: `Bearer ${SCRAPER_API_KEY}`,
        Accept: "application/json",
      },
    });

    const data = await resp.json();

    // These are the WRONG fields that trader-worker v1.5.0-1.6.1 incorrectly expected
    expect(data).not.toHaveProperty("success");
    expect(data).not.toHaveProperty("data");
    expect(data).not.toHaveProperty("count");

    // These are the CORRECT fields
    expect(data).toHaveProperty("signals");
    expect(data).toHaveProperty("total_signals");
  });
});
