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

The synthesis pass is now judge-driven and vote-aware. It now:

- gives each seat an explicit viewpoint before the final decision
- triggers a majority vote when seats disagree (2-of-3 rule for three seats)
- classifies claims as `accepted`, `monitor`, or `rejected`
- emits a machine-readable `resolutionTrace` and deliberation record for evaluation and debugging
- emits a `decisionRationale` summary with key factors behind the selected direction

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run eval:mock
npm run eval:benchmark:mock
```

## Project Hygiene

- Every major behavioral or architecture update should include a matching README update in the same commit.
- Keep protocol sections current when synthesis contracts, vote logic, or evaluation dimensions change.

## Evaluation Harness

The repo can now score the council against a single-agent baseline.

What it does:

- Runs a default suite of prompts designed for ambiguity, tradeoffs, and disagreement
- Executes the full council loop for each case
- Executes a single-agent baseline using `COE_BASELINE_AGENT` or `gpt` by default
- Scores both outputs across structure, actionability, calibration, conflict resolution, and prompt-signal coverage
- Tracks deliberation protocol metrics including agreement rate, vote-required frequency, `challengeAbsent`, minority-overruled frequency, and a minority correctness proxy
- Persists a full result bundle under `data/evals/`

Benchmark mode:

- Use `npm run eval:benchmark:mock` for a 13-case side-by-side council-vs-baseline benchmark.
- Use `npm run eval:benchmark` to run the same benchmark in your configured provider mode.

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
