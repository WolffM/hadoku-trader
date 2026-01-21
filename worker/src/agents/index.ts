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
  SkipReason,
  ExecuteReason,
  DecisionReason,
  SKIP_REASON_DISPLAY,
  getReasonDisplay,
  AgentDecision,
  ScoreResult,
  // Trade action types (Phase 5)
  TradeAction,
  // API response types
  AgentSummary,
  AgentDetailResponse,
  AgentPosition,
  AgentTrade,
  AgentsListResponse,
  ProcessSignalsResponse,
  // Position types (Phase 3)
  PositionRow,
  CloseReason,
  // Execution types (Phase 3)
  ExecutionResult,
  ExecutionDetails,
  FidelityTradeRequest,
  FidelityTradeResponse,
  // Monitoring types (Phase 3)
  ExitDecision,
  MonitorResult,
} from "./types";

// =============================================================================
// Configuration Exports
// =============================================================================

export {
  CHATGPT_CONFIG,
  CLAUDE_CONFIG,
  GEMINI_CONFIG,
  NAIVE_CONFIG,
  SPY_BENCHMARK_CONFIG,
  AGENT_CONFIGS,
  TRADING_AGENTS,
  CONTROL_AGENTS,
  ALL_AGENTS,
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
  getAgentTickerPosition,
} from "./loader";

// =============================================================================
// Scoring Exports
// =============================================================================

export {
  // Main scoring function
  calculateScore,
  // Helper for confirmation counting
  getSignalConfirmationCount,
} from "./scoring";

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
  // Pure analysis function (Phase 5)
  analyzeSignals,
} from "./router";

// =============================================================================
// Sizing Exports (Phase 3)
// =============================================================================

export {
  // Position sizing calculation
  calculatePositionSize,
  calculateShares,
  validatePositionSize,
} from "./sizing";

// =============================================================================
// Execution Exports (Phase 3)
// =============================================================================

export {
  // Trade execution
  executeTrade,
  createPosition,
  updateTradeExecution,
  getPendingTradeId,
  // Fidelity API
  callFidelityApi,
  executeSellOrder,
} from "./execution";

// =============================================================================
// Monitor Exports (Phase 3)
// =============================================================================

export {
  // Position monitoring
  monitorPositions,
  checkExitConditions,
  closePosition,
  updateHighestPrice,
} from "./monitor";

// =============================================================================
// Simulation Exports (Phase 4)
// =============================================================================

export {
  // Core simulation classes
  SimulationClock,
  SignalReplayer,
  PortfolioState,
  EventLogger,
  // Types
  type SignalForSim,
  // Utilities
  daysBetween as simDaysBetween,
  addDays as simAddDays,
  generateSimId,
} from "./simulation";

export {
  // Price providers
  MockPriceProvider,
  StaticPriceProvider,
  D1PriceProvider,
  type PriceProvider,
  type AsyncPriceProvider,
  type OHLC,
  type MarketPriceRow,
} from "./priceProvider";

export {
  // Metrics calculation
  calculateMetrics,
  compareAgents,
  calculateInformationRatio,
  calculateSortinoRatio,
} from "./metrics";

// =============================================================================
// Smart Simulation Exports
// =============================================================================

export {
  // Smart agent config
  SMART_CONFIG,
  ALL_SIM_AGENTS,
  // Smart sizing
  calculateSmartPositionSize,
  getCapitolSizeBucket,
  // Statistics
  calculateDetailedStats,
  printSimulationReport,
  type DetailedStats,
  type SimulationSummary,
} from "./run-simulation";

// Simulation-specific types
export type {
  SimPosition,
  DailySnapshot,
  AgentPortfolio,
  FilterCheck,
  ScoreBreakdown,
  SizeCalculation,
  ReasoningChain,
  AgentDecisionWithReasoning,
  SimulationEvent,
  SimulationEventType,
  PerformanceMetrics,
  SimulationReport,
} from "./types";
