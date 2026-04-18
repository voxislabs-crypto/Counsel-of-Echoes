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

## Scripts

```bash
npm run dev
npm run build
npm run start
```

## Next Steps

- Replace heuristic synthesis with a dedicated judge/synthesizer model
- Add replayable run history in the frontend
- Add evaluation harnesses against single-model baselines
- Add persona render variants that preserve the canonical claim set
