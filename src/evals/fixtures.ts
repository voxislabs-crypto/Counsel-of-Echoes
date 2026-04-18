import type { EvalCase } from "./schemas.js";

export const defaultEvalCases: EvalCase[] = [
  {
    id: "launch-proof",
    title: "Prove the council beats one model",
    question: "How should Council of Echoes prove that structured multi-model disagreement beats a single strong model?",
    context: "Assume a small MVP, limited time, and a need for measurable outcomes rather than a flashy demo.",
    tags: ["strategy", "measurement", "ambiguity"],
    requiredSignals: ["baseline", "measure", "evaluation", "latency"]
  },
  {
    id: "conflict-resolution",
    title: "Resolve a strategic conflict",
    question: "A product team wants to launch avatars and voice next week, but the backend still uses heuristic synthesis. What should ship first and why?",
    context: "Prioritize long-term platform value over visual polish and keep the answer grounded in engineering tradeoffs.",
    tags: ["conflict", "priority", "tradeoff"],
    requiredSignals: ["synthesis", "evaluation", "risk", "cost"]
  },
  {
    id: "uncertainty-preservation",
    title: "Preserve uncertainty honestly",
    question: "How should a multi-agent reasoning platform present disagreement when the models do not converge on a single answer?",
    context: "The goal is to increase user trust without forcing false consensus.",
    tags: ["ambiguity", "trust", "uncertainty"],
    requiredSignals: ["uncertainty", "disagreement", "confidence", "user trust"]
  }
];