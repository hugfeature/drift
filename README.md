# drift

> Observability for autonomous coding agents.

Drift helps developers understand what agents are doing before things go wrong.

---

## Why Drift

Coding agents are getting increasingly autonomous.

They:
- read and modify code
- retry failed actions
- call tools repeatedly
- search documentation
- rewrite implementation paths
- burn thousands of tokens while you stare at a terminal wondering:

> “Is this thing actually making progress?”

Today, developers still have very limited visibility into:
- what agents are doing
- whether they are stuck
- why token costs explode
- when goals start drifting
- when humans should intervene

Drift is an observability layer for coding agents.

Not another chat UI.
Not another wrapper.

A runtime lens into agent behavior.

---

# Core Ideas

## Runtime Observability

Treat coding agents like distributed systems.

We already have:
- logs
- tracing
- metrics
- replay
- observability

for backend infrastructure.

But AI agents still operate like black boxes.

Drift brings runtime visibility to autonomous workflows.

---

## Drift Detection

Agents rarely fail instantly.

They drift.

Examples:
- repeated tool calls
- endless retries
- token growth without progress
- context degradation
- rollback loops
- excessive file churn

Drift detects these patterns before humans lose trust.

---

## Human Takeover

Autonomy should not mean invisibility.

Drift helps developers decide:
- when to let the agent continue
- when to intervene
- when to stop execution entirely

---

# MVP

The first version focuses on a single experience:

## Observe a coding agent in real time.

Features:
- real-time timeline
- semantic event stream
- token usage tracking
- loop detection
- replay session
- runtime risk indicators

---

# Example Runtime Timeline

```txt
[10:21] Searching authentication flow
[10:22] Reading src/auth.ts
[10:23] Editing token refresh logic
[10:24] Running tests
[10:24] Tests failed
[10:25] Retrying implementation
[10:26] Possible loop detected
```

Instead of raw logs, Drift converts noisy execution traces into understandable runtime states.

---

# Event Model

```json
{
  "id": "evt_001",
  "timestamp": 1747051200,
  "agent": "claude-code",
  "type": "tool_call",
  "status": "running",
  "tool": "edit_file",
  "target": "src/auth.ts",
  "tokens": 1200,
  "message": "Updating auth flow"
}
```

---

# Architecture

```txt
Agent Runtime
      ↓
Event Interceptor
      ↓
Normalized Events
      ↓
Drift Detection Engine
      ↓
Realtime Timeline UI
```

---

# Tech Stack

## Frontend
- Next.js
- TailwindCSS
- shadcn/ui
- WebSocket stream

## Backend
- Node.js
- Fastify
- Event ingestion layer
- Runtime analyzer

---

# Roadmap

## Phase 1
- realtime timeline
- event ingestion SDK
- semantic state mapping
- replay viewer

## Phase 2
- drift scoring
- anomaly detection
- multi-agent sessions
- runtime checkpoints

## Phase 3
- OpenTelemetry integration
- LangGraph support
- Claude Code adapter
- Cursor adapter
- agent benchmarking

---

# Vision

AI agents are becoming operational systems.

Operational systems require observability.

Drift aims to become the runtime visibility layer for autonomous software agents.

---

# Status

Early prototype.

Currently focused on:
- coding agent tracing
- runtime replay
- agent drift detection

Contributions and discussions are welcome.
