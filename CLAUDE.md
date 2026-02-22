# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
pnpm build           # full build (lib + web)
pnpm build:lib       # TypeScript library only
pnpm typecheck       # tsc --noEmit
pnpm check:fix       # biome check --write src/
pnpm check:arch      # enforce architectural layer boundaries

# Unit + integration tests (no credentials needed)
pnpm test                           # all unit + integration tests
pnpm exec vitest run -t "test name" # single test by name

# E2E smoke — binary in PATH, no API key (every PR)
pnpm test:e2e:smoke                 # all adapters
pnpm test:e2e:claude:smoke          # single adapter

# E2E full — binary + API key or CLI OAuth, sends real prompts (nightly)
pnpm test:e2e:full                  # all adapters
pnpm test:e2e:<adapter>             # e.g. :claude :gemini :codex :opencode :agent-sdk

# Single e2e test with full tracing
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  E2E_PROFILE=real-full USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/session-coordinator-gemini.e2e.test.ts \
  --config vitest.e2e.real.config.ts -t "test name" 2>trace.ndjson
pnpm trace:inspect   # analyze trace.ndjson
```

## Worktree Workflow

Always work in an isolated worktree, never directly on `main`.

```bash
# Create
git worktree add .worktrees/<name> -b <type>/<branch>
# e.g. git worktree add .worktrees/fix-gemini -b fix/gemini-e2e

# List / remove
git worktree list
git worktree remove .worktrees/<name>
```

## Architecture

BeamCode bridges **consumers** (browser/mobile via WebSocket) to **local AI CLI backends** (Claude, Codex, Gemini, OpenCode, ACP agents).

**Four bounded contexts:** SessionControl · BackendPlane · ConsumerPlane · MessagePlane

**Session flow:**
```
SessionCoordinator → SessionRuntime → BackendAdapter → BackendSession
                                   ↘ DomainEvent (pub/sub, runtime-only)
```

**Translation boundaries** (pure functions, bugs live here):

| | Boundary | File |
|-|----------|------|
| T1 | `ConsumerMessage → UnifiedMessage` | `src/core/messaging/inbound-normalizer.ts` |
| T2 | `UnifiedMessage → NativeCLI` | adapter `send()` |
| T3 | `NativeCLI → UnifiedMessage` | adapter message loop |
| T4 | `UnifiedMessage → ConsumerMessage` | `src/core/messaging/unified-message-router.ts` |

**Debugging:** `dumpTraceOnFailure()` fires automatically on test failure. For deeper inspection add `BEAMCODE_TRACE=1`, redirect stderr to `trace.ndjson`, then run `pnpm trace:inspect`. A `-field` entry in the diff means it was silently dropped at that boundary. See [DEVELOPMENT.md](DEVELOPMENT.md) for the full guide.
