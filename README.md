# Counsel of Echoes

Counsel of Echoes is a full-stack MVP for a controlled multi-model deliberation system.

It is intentionally not a free-form chatbot swarm. The runtime is a bounded state machine:

1. Fan out the same question to multiple seats.
2. Collect typed proposals.
3. Run one critique pass.
4. Synthesize a single verdict.
5. Stream the run to a live round-table UI.

The project ships with a mock runtime so it works immediately, plus optional live provider adapters for OpenAI, Anthropic, and xAI.

## What Is Implemented

- TypeScript backend with Express and WebSocket streaming
- Typed proposal, critique, synthesis, and event schemas with Zod
- Local run persistence under `data/runs/`
- Evaluation harness with persisted council-vs-baseline comparisons under `data/evals/`
- Critique-weighted synthesis with explicit claim resolution traces
- Mock providers for GPT, Claude, Grok, and optional Voxis
- Live provider hooks for OpenAI, Anthropic, and xAI
- Round-table frontend with proposal seats, event trace, and verdict panel

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Then open `http://localhost:3000`.

The default mode is `mock`, so the app runs without API keys.

## Live Providers

Set `COE_PROVIDER_MODE=live` and add whichever keys you have:

```env
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
XAI_API_KEY=...
```

If fewer than two live providers are configured, the server falls back to mock mode automatically.

## Architecture

Core loop:

```text
Question
	-> parallel proposals
	-> single critique pass
	-> synthesis
	-> streamed verdict
```

Important separation:

- Truth layer: typed proposals, critiques, synthesis
- Presentation layer: streaming UI, seat styling, dramatic framing

That keeps the theatrical interface from contaminating the factual reasoning path.

The synthesis pass is no longer a simple top-claim merge. It now:

- scores each claim against critique pressure
- classifies claims as `accepted`, `monitor`, or `rejected`
- lowers confidence when disagreement survives resolution
- emits a machine-readable `resolutionTrace` for evaluation and debugging

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run eval:mock
```

## Evaluation Harness

The repo can now score the council against a single-agent baseline.

What it does:

- Runs a default suite of prompts designed for ambiguity, tradeoffs, and disagreement
- Executes the full council loop for each case
- Executes a single-agent baseline using `COE_BASELINE_AGENT` or `gpt` by default
- Scores both outputs across structure, actionability, calibration, conflict resolution, and prompt-signal coverage
- Persists a full result bundle under `data/evals/`

Run it locally:

```bash
npm run eval:mock
```

Or through the API:

```bash
curl -X POST http://localhost:3000/api/evals -H 'Content-Type: application/json' -d '{"mode":"mock"}'
```

## Next Steps

- Replace heuristic synthesis with a dedicated judge/synthesizer model
- Add replayable run history in the frontend
- Add persona render variants that preserve the canonical claim set
