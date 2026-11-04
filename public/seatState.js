export const WAITING_COPY = "Waiting for a proposal...";
export const FAILED_COPY = "Proposal failed.";

export function initialSeatCard() {
  return {
    copy: WAITING_COPY,
    meta: ["Idle"],
    active: false,
    failed: false
  };
}

export function reduceSeatCard(card, event) {
  if (event?.type === "proposal.started") {
    const payload = event.payload ?? {};
    return {
      ...card,
      active: true,
      failed: false,
      copy: card.copy === WAITING_COPY ? "Preparing a proposal..." : card.copy,
      meta: [payload.providerName, payload.modelName, "Thinking"].filter(Boolean)
    };
  }

  if (event?.type === "proposal.failed") {
    return {
      ...card,
      active: false,
      failed: true,
      copy: FAILED_COPY,
      meta: ["Failed", shorten(event.payload?.message)]
    };
  }

  if (event?.type === "proposal.completed") {
    const proposal = event.payload?.proposal ?? {};
    const claims = Array.isArray(proposal.claims) ? proposal.claims : [];
    return {
      ...card,
      active: false,
      failed: false,
      copy: typeof proposal.summary === "string" && proposal.summary ? proposal.summary : card.copy,
      meta: [
        `Confidence ${Math.round((Number(proposal.confidence) || 0) * 100)}%`,
        ...claims.slice(0, 2).map((claim) => claim.statement).filter(Boolean)
      ]
    };
  }

  if (event?.type === "critique.failed") {
    return {
      ...card,
      active: false,
      meta: [...card.meta.filter((item) => item !== "Critique failed"), "Critique failed"]
    };
  }

  return card;
}

function shorten(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return "The seat did not return a valid proposal.";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
