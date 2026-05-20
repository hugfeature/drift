/**
 * Timeline: LangSmith trace to Drift fixture bridge.
 *
 * Role in Drift architecture:
 *
 *   EventIngestion (drift runtime)
 *       -> LangSmith exporter (outbound, src/exporters/)
 *   LangSmith Dashboard (external observability + visualization)
 *       -> trace export
 *   timeline.ts (this module, inbound)
 *       -> convert to internal format
 *   eval/fixtures/*.json (Drift eval corpus)
 *
 * This module bridges external LangSmith traces back into Drift internal
 * EvalFixture format for offline replay and scoring.
 *
 * Dependencies:
 *   - langsmith SDK (for fetching run trees from LangSmith API)
 *   - src/types/eval.ts (EvalFixture schema)
 *
 * Blocked on LangSmith exporter (Week 1-2).
 * Will be built during Golden Dataset expansion (Week 4-5).
 */

export {}
