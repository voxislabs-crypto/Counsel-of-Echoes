# Next Steps

Counsel of Echoes has a three-seat council loop, a council-versus-baseline eval harness, and a critique-weighted synthesis pass. The judge is a council seat, with preference claude, then gpt, then grok, and a heuristic fallback. Dispositions stay `accepted`, `monitor`, and `rejected`.

Voxis stays a localhost context sidecar. It does not fetch external evidence, and it is not a fourth seat.

The next research work is heterogeneous evidence. Evaluation, routing, and UI work below stays open.

## Research today

Research runs only when the request sets `research: true`. A research-off run skips gathering, and that path has to keep succeeding.

When research is on, `gather()` runs once after routing and before proposals. The query is the question. Mock mode uses fixtures. Ollama and live call the Strategist Wikipedia adapter, the Chaos Gremlin Reddit adapter, and the Analyst Semantic Scholar adapter, then put the results in one shared bundle in that order. Each adapter returns at most 3 items. The bundle holds at most 9. Each item has an id, title, source URL, and an excerpt of at most 800 characters. `sourceKind` is `wikipedia`, `reddit`, `scholar`, or `fixture`. Unknown evidence ids are stripped. An empty search is recorded and the round continues. `evidenceId` on a finding stays a required string. A null id is filled only from a source the finding or its claim already names.

Seats stay gpt → llama3.1:8b (Strategist), claude → mistral:7b (Analyst), grok → qwen2.5:7b (Chaos Gremlin).

The current bundle is shared and is collected before any seat has claims. Retrieval that needs proposal claims is a second pass after proposals. The pre-proposal gather stays until that pass replaces it.

## External sources

Add read-only sources as evidence input. Proposal, critique, and synthesis schemas stay. The three seats stay. Research-off still skips gathering.

### Phase 1 — Source adapters

Each adapter takes a query and returns 1–3 packets that map onto the current evidence item: id, title, source URL, excerpt, and source kind. No full-page dumps. Each adapter is tested on its own before the council calls it.

- Strategist → Wikipedia. Search and extract already live in `src/research/wikipedia.ts`. This phase assigns that client to the Strategist. It does not add a second Wikipedia client.
- Analyst → Semantic Scholar or arXiv. Public endpoints, no key for basic use. Return titles, abstracts, and DOIs or URLs.
- Chaos Gremlin → Reddit public JSON. A configurable subreddit list starts with r/changemyview, r/AskHistorians, and topic-specific subs. Return post titles, top comments, and permalinks. Filter on score and age.

Guardrails for this phase:

- A failed or rate-limited call returns no items and the run continues.
- Outbound queries are the question or a claim statement. Run context and Voxis persona text stay local.
- At most 3 items per adapter. Excerpts stay inside the current 800-character cap.
- Every packet stores its source URL.
- New hosts go through `safeFetch`.
- Mock mode keeps using fixtures.

### Phase 2 — Evidence bundle

When research is on, call the adapters and normalize their packets into the evidence bundle. `evidenceFindingSchema` stays as it is. The shared cap of 3 items rises to at most 9, three per seat, and `sourceKind` gains scholar and reddit values. Critique prompts already tell models to copy `evidenceId` from the bundle.

The claim-aware call runs after proposals exist. Until then, an adapter may run on the question alone in the current pre-proposal slot.

### Phase 3 — Seat-specific retrieval

Shape each query for its seat. Strategist queries favor encyclopedic framing. Analyst queries favor papers with abstracts and citations. Gremlin queries favor high-engagement counter-arguments. A run may override the subreddit list or the Scholar query. Voxis may supply that override later. Voxis still does not perform the fetch.

### Phase 4 — Multi-round critique

After one run has used all three sources, try a second critique round. The default stays one round. Log whether round 2 adds cross-source rebuttals or restates the first round. This waits until a real three-source run exists.

### Order

1. Wikipedia adapter assigned to the Strategist, with research on. In `src/research/seatSources.ts`. A research-on run fills the shared bundle from that adapter. Analyst and Gremlin still read the same bundle.
2. Reddit adapter for the Gremlin, with the same check. In `src/research/reddit.ts`, assigned in `src/research/seatSources.ts`. A research-on run appends those items to the shared bundle. The default subreddits are r/changemyview, r/AskHistorians, and r/explainlikeimfive.
3. Scholar adapter for the Analyst. In `src/research/scholar.ts`, assigned in `src/research/seatSources.ts`. A research-on run appends those items after Wikipedia and Reddit. The client is the public Semantic Scholar graph search. No API key.
4. One three-source run, then a decision on the second critique round.

## Evaluation

1. Expand the evaluation suite with domain-specific prompts that matter for real users.
2. Add blind review fields so humans can score council and baseline outputs side by side.
3. Track regressions by comparing new eval results with previous suites in `data/evals/`.

## Routing

1. Add a lightweight router so simple prompts do not wake the full council.
2. Route high-ambiguity, high-risk, or conflict-heavy prompts into the full chamber.
3. Log router decisions so they can be audited against eval outcomes.

## UI

1. Show the synthesis resolution trace in the interface before adding richer theatrical features.
2. Add replay for a completed run from stored events and eval suites.
3. After that, add avatars, interruption choreography, and voice.

## Voxis Integration

Voxis is a localhost context sidecar, not a seat. In ollama mode the orchestrator fetches one context block per seat before proposals, injects it into that seat's system prompt, and after synthesis fires a non-blocking `POST /api/internal/round`. Critique and synthesis do not call Voxis. A down sidecar yields empty context and the round still finishes.

Bind seats with `VOXIS_SEAT_GPT`, `VOXIS_SEAT_CLAUDE`, and `VOXIS_SEAT_GROK` on the Voxis process. CoE reads `VOXIS_URL` (default `http://127.0.0.1:3101`). Set `VOXIS_CONTEXT=false` to skip the sidecar.

## Operational Notes

1. Run `npm run eval:mock` after synthesis changes to keep quality visible.
2. Use `POST /api/evals` for persisted comparisons from the running app.
3. Treat confidence calibration failures as first-class bugs, not cosmetic issues.
