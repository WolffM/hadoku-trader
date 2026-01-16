/**
 * Multi-Agent Trading Engine
 *
 * This module provides the core infrastructure for running multiple trading agents
 * with different strategies against congressional trade signals.
 *
 * Agents:
 * - ChatGPT ("Decay Edge"): 5-component scoring, score² sizing
 * - Claude ("Decay Alpha"): 6-component scoring, linear sizing
 * - Gemini ("Titan Conviction"): 5 Titans only, pass/fail, equal split
 */

// =============================================================================
// Type Exports
// =============================================================================

export type {
  // Scoring types
  TimeDecayConfig,
  PriceMovementConfig,
  PositionSizeConfig,
  PoliticianSkillConfig,
  SourceQualityConfig,
  FilingSpeedConfig,
  CrossConfirmationConfig,
  ScoringConfig,
  // Sizing types
  SizingMode,
  SizingConfig,
  // Exit types
  StopLossMode,
  StopLossConfig,
  TakeProfitConfig,
  SoftStopConfig,
  ExitConfig,
  // Agent types
  AssetType,
  AgentConfig,
  // Database row types
  AgentRow,
  AgentBudgetRow,
  PoliticianStatsRow,
  AgentPerformanceRow,
  // Signal processing types
  EnrichedSignal,
  FilterReason,
  DecisionReason,
  AgentDecision,
  ScoreResult,
  // API response types
  AgentSummary,
  AgentDetailResponse,
  AgentPosition,
  AgentTrade,
  AgentsListResponse,
  ProcessSignalsResponse,
} from "./types";

// =============================================================================
// Configuration Exports
// =============================================================================

export {
  CHATGPT_CONFIG,
  CLAUDE_CONFIG,
  GEMINI_CONFIG,
  AGENT_CONFIGS,
  GEMINI_CONSENSUS_CORE,
  GEMINI_RESERVES,
} from "./configs";

// =============================================================================
// Filter & Utility Exports
// =============================================================================

export {
  // Signal filtering
  shouldAgentProcessSignal,
  // Date utilities
  daysBetween,
  getCurrentDate,
  getCurrentMonth,
  addDays,
  // Price utilities
  calculatePriceChangePct,
  // Signal enrichment
  enrichSignal,
  type RawSignalRow,
  // Math utilities
  lerp,
  clamp,
  roundTo,
  // ID generation
  generateId,
} from "./filters";

// =============================================================================
// Loader Exports (DB Operations)
// =============================================================================

export {
  // Agent loading
  getActiveAgents,
  getAgent,
  agentExists,
  // Budget management
  getAgentBudget,
  updateAgentBudget,
  resetMonthlyBudgets,
  // Seeding
  seedAgentsFromCode,
  // Configuration updates
  updateAgentConfig,
  setAgentActive,
  // Politician stats
  getPoliticianStats,
  upsertPoliticianStats,
  // Position queries
  countAgentPositions,
  countAgentTickerPositions,
  getAgentPositions,
} from "./loader";

// =============================================================================
// Router Exports (Signal Processing)
// =============================================================================

export {
  // Main routing
  routeSignalToAgents,
  // Signal processing
  getUnprocessedSignals,
  markSignalProcessed,
  getCurrentPrice,
  processAllPendingSignals,
} from "./router";
