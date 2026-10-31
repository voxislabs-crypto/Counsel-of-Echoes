# Next Steps

This repo now has three real pillars:

- a controlled council loop
- a council-vs-baseline evaluation harness
- a critique-weighted synthesis pass with resolution traces

The next work should focus on the parts that most improve reasoning quality per unit of complexity.

## Highest Leverage

1. Replace the current algorithmic synthesis pass with a dedicated judge model.
2. Feed the judge typed proposals, critiques, and the current resolution trace rather than raw prose.
3. Keep the same `accepted | monitor | rejected` contract so the rest of the system does not need to change.

## Evaluation

1. Expand the evaluation suite with domain-specific prompts that matter for your real users.
2. Add blind review fields so humans can score council vs baseline outputs side by side.
3. Track regressions over time by comparing new eval results against previous persisted suites in `data/evals/`.

## Routing

1. Add a lightweight router so simple prompts do not wake the full council.
2. Route high-ambiguity, high-risk, or conflict-heavy prompts into the full chamber.
3. Log router decisions so they can be audited against eval outcomes.

## UI

1. Show synthesis resolution trace in the interface before adding richer theatrical features.
2. Add replay for a completed run from stored events and eval suites.
3. Only after that, add avatars, interruption choreography, and voice.

## Voxis Integration

Voxis is a localhost context sidecar, not a seat. In ollama mode the orchestrator fetches one context block per seat before proposals, injects it into that seat's system prompt, and after synthesis fires a non-blocking `POST /api/internal/round`. Critique and synthesis do not call Voxis. A down sidecar yields empty context and the round still finishes.

Bind seats with `VOXIS_SEAT_GPT`, `VOXIS_SEAT_CLAUDE`, and `VOXIS_SEAT_GROK` on the Voxis process. CoE reads `VOXIS_URL` (default `http://127.0.0.1:3101`). Set `VOXIS_CONTEXT=false` to skip the sidecar.

## Operational Notes

1. Run `npm run eval:mock` after synthesis changes to keep quality visible.
2. Use `POST /api/evals` for persisted comparisons from the running app.
3. Treat confidence calibration failures as first-class bugs, not cosmetic issues.