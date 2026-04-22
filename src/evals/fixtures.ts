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

export const benchmarkEvalCases: EvalCase[] = [
  ...defaultEvalCases,
  {
    id: "policy-exception",
    title: "Handle policy exception pressure",
    question: "A customer success lead wants to bypass a risky data policy for one enterprise account. What should the product team do?",
    context: "Prioritize long-term trust and compliance while preserving customer relationship options.",
    tags: ["policy", "risk", "tradeoff"],
    requiredSignals: ["compliance", "risk", "alternative", "escalation"]
  },
  {
    id: "incident-communication",
    title: "Incident response communication",
    question: "Your service has partial outages and uncertain root cause. What should be communicated to customers in the first 30 minutes?",
    context: "Balance transparency, uncertainty, and operational safety.",
    tags: ["incident", "uncertainty", "trust"],
    requiredSignals: ["timeline", "uncertainty", "next update", "mitigation"]
  },
  {
    id: "pricing-shift",
    title: "Pricing strategy under churn risk",
    question: "Should a startup increase prices now to improve margins even though churn risk is rising?",
    context: "Assume runway pressure and incomplete segment-level churn data.",
    tags: ["pricing", "ambiguity", "strategy"],
    requiredSignals: ["segment", "experiment", "risk", "measurement"]
  },
  {
    id: "model-routing",
    title: "Router threshold design",
    question: "How should a model router decide when to send prompts to the full council versus a single model?",
    context: "Keep latency and cost controlled while preserving quality on high-risk prompts.",
    tags: ["routing", "cost", "quality"],
    requiredSignals: ["threshold", "risk", "latency", "audit"]
  },
  {
    id: "security-disclosure",
    title: "Security disclosure timing",
    question: "A moderate security bug is found with no known exploit. Disclose immediately or after patching?",
    context: "Balance user trust, exploit risk, and operational readiness.",
    tags: ["security", "conflict", "priority"],
    requiredSignals: ["severity", "patch", "communication", "timeline"]
  },
  {
    id: "hiring-freeze",
    title: "Hiring freeze tradeoff",
    question: "Should leadership freeze hiring to extend runway if engineering velocity is already below target?",
    context: "Assume uncertain revenue and strong competitive pressure.",
    tags: ["tradeoff", "operations", "uncertainty"],
    requiredSignals: ["runway", "velocity", "phasing", "risk"]
  },
  {
    id: "evaluation-design",
    title: "Design a robust eval plan",
    question: "What is the minimum viable evaluation plan to prove a multi-agent system beats a strong single-model baseline?",
    context: "Keep it practical for a small team with limited annotation budget.",
    tags: ["evaluation", "measurement", "strategy"],
    requiredSignals: ["baseline", "blind review", "regression", "sample size"]
  },
  {
    id: "governance-override",
    title: "Executive override request",
    question: "An executive asks for a fast launch that bypasses governance gates. How should the team respond?",
    context: "Maintain alignment, avoid political escalation, and protect long-term platform integrity.",
    tags: ["governance", "conflict", "risk"],
    requiredSignals: ["gates", "exception", "accountability", "alternative"]
  },
  {
    id: "confidence-calibration",
    title: "Calibrate confidence messaging",
    question: "How should the system present confidence when evidence is mixed but a decision is still required?",
    context: "Avoid false certainty while still giving actionable direction.",
    tags: ["calibration", "uncertainty", "communication"],
    requiredSignals: ["confidence", "uncertainty", "decision", "monitor"]
  },
  {
    id: "product-reliability",
    title: "Reliability vs feature pressure",
    question: "Should the team delay a major feature release to address reliability issues that affect 8% of sessions?",
    context: "Revenue pressure exists, but trust erosion is becoming visible.",
    tags: ["priority", "reliability", "tradeoff"],
    requiredSignals: ["impact", "risk", "sequence", "mitigation"]
  }
];