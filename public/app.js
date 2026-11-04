import { FAILED_COPY, initialSeatCard, reduceSeatCard, WAITING_COPY } from "./seatState.js";

const state = {
  runId: null,
  socket: null,
  agents: new Map(),
  config: null
};

const runtimeMode = document.querySelector("#runtime-mode");
const modeSelect = document.querySelector("#mode");
const ollamaNote = document.querySelector("#ollama-note");
const agentsElement = document.querySelector("#agents");
const eventsElement = document.querySelector("#events");
const verdictTitle = document.querySelector("#verdict-title");
const verdictBody = document.querySelector("#verdict-body");
const verdictMeta = document.querySelector("#verdict-meta");
const runForm = document.querySelector("#run-form");
const submitButton = document.querySelector("#submit-button");
const lensCode = document.querySelector("#lens-code");
const contextField = document.querySelector("#context");
const contextPlaceholder = contextField.getAttribute("placeholder");

initialize().catch((error) => {
  console.error(error);
  addEventCard("System", "Failed to initialize the interface.");
});

async function initialize() {
  const configResponse = await fetch("/api/config");
  state.config = await configResponse.json();
  modeSelect.value = state.config.providerMode;
  syncModeUI();
  renderAgentCards(visibleAgents());
  connectSocket();
}

modeSelect.addEventListener("change", () => {
  syncModeUI();
  renderAgentCards(visibleAgents());
});

lensCode.addEventListener("change", () => {
  contextField.placeholder = lensCode.checked
    ? "Paste the code or persona text the seats should argue about. No file access yet."
    : contextPlaceholder;
});

function visibleAgents() {
  return state.config.agents.filter((agent) => {
    if (modeSelect.value === "ollama") {
      return agent.id !== "voxis";
    }

    return agent.id !== "voxis" || state.config.includeVoxis;
  });
}

function syncModeUI() {
  ollamaNote.classList.toggle("hidden", modeSelect.value !== "ollama");
  runtimeMode.textContent = `${modeSelect.value.toUpperCase()} mode`;
}

runForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(runForm);
  const question = String(formData.get("question") ?? "").trim();
  const context = String(formData.get("context") ?? "").trim();
  const mode = String(formData.get("mode") ?? "mock");
  const lens = lensCode.checked ? "code" : "general";

  if (question.length < 10) {
    addEventCard("Validation", "Use a question with at least 10 characters so the council has something real to work with.");
    return;
  }

  resetRunState();
  submitButton.disabled = true;
  submitButton.textContent = "Council Running...";

  const response = await fetch("/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ question, context, mode, lens })
  });

  const body = await response.json();

  if (!response.ok) {
    addEventCard("Run rejected", body.message ?? "The council could not start.");
    submitButton.disabled = false;
    submitButton.textContent = "Start Council Run";
    return;
  }

  state.runId = body.runId;
  state.socket?.send(JSON.stringify({ type: "subscribe", runId: state.runId }));
  verdictTitle.textContent = "Deliberation in progress";
  verdictBody.innerHTML = "<p>The chamber is assembling proposals and preparing a single critique pass.</p>";
  verdictMeta.innerHTML = "";
});

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  state.socket.addEventListener("open", () => {
    addEventCard("System", "WebSocket connected. The chamber can stream events live.");
    if (state.runId) {
      state.socket.send(JSON.stringify({ type: "subscribe", runId: state.runId }));
    }
  });

  state.socket.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    if (!event.type || !state.runId || event.runId !== state.runId) {
      return;
    }

    handleEvent(event);
  });

  state.socket.addEventListener("close", () => {
    addEventCard("System", "WebSocket disconnected. Refresh the page to reconnect.");
  });
}

function renderAgentCards(agents) {
  agentsElement.innerHTML = "";

  for (const agent of agents) {
    const seat = initialSeatCard();
    state.agents.set(agent.id, seat);
    const card = document.createElement("article");
    card.className = "agent-card";
    card.id = `agent-${agent.id}`;
    card.style.setProperty("--agent-glow", `${agent.accent}55`);
    card.style.setProperty("--agent-shadow", `${agent.color}33`);
    card.innerHTML = `
      <div class="agent-head">
        <div>
          <div class="agent-seat">${agent.seat}</div>
          <div>${agent.label}</div>
        </div>
        <div class="agent-badge">${agent.label.slice(0, 2).toUpperCase()}</div>
      </div>
      <p class="agent-copy" id="agent-copy-${agent.id}">${seat.copy}</p>
      <div class="agent-meta" id="agent-meta-${agent.id}">
        <span class="pill">Idle</span>
      </div>
    `;
    agentsElement.appendChild(card);
  }
}

function handleEvent(event) {
  switch (event.type) {
    case "route.selected":
      addEventCard("Route selected", `${event.payload.providers.map((provider) => `${provider.agentId}:${provider.mode}`).join(" | ")}`);
      break;
    case "proposal.started":
      applySeatEvent(event.agentId, event);
      addEventCard(`${event.agentId} started`, `Preparing a proposal with ${event.payload.modelName}.`);
      break;
    case "proposal.delta":
      appendAgentCopy(event.agentId, event.payload.delta);
      break;
    case "proposal.completed":
      applySeatEvent(event.agentId, event);
      addEventCard(`${event.agentId} proposed`, event.payload.proposal.summary);
      break;
    case "proposal.failed":
      applySeatEvent(event.agentId, event);
      addEventCard(`${event.agentId} failed`, event.payload?.message || FAILED_COPY);
      break;
    case "critique.started":
      addEventCard(`${event.agentId} critiques`, `Pressure-testing ${event.payload.targetAgentId}.`);
      break;
    case "critique.completed":
      addEventCard(`${event.agentId} critique`, event.payload.critique.concerns[0]);
      break;
    case "critique.failed":
      applySeatEvent(event.agentId, event);
      addEventCard(`${event.agentId} critique failed`, event.payload?.message || "Critique failed.");
      break;
    case "synthesis.started":
      verdictTitle.textContent = "Synthesizing verdict";
      verdictBody.innerHTML = "<p>The chamber is compressing disagreements into a final answer.</p>";
      break;
    case "synthesis.completed":
      renderVerdict(event.payload.synthesis);
      addEventCard("Verdict completed", event.payload.synthesis.finalAnswer);
      break;
    case "run.completed":
      submitButton.disabled = false;
      submitButton.textContent = "Start Council Run";
      addEventCard("Run completed", `Confidence band: ${event.payload.confidenceBand}.`);
      break;
    case "run.failed":
      submitButton.disabled = false;
      submitButton.textContent = "Start Council Run";
      verdictTitle.textContent = "Run failed";
      verdictBody.innerHTML = `<p>${event.payload.message}</p>`;
      addEventCard("Run failed", event.payload.message);
      break;
    default:
      break;
  }
}

function renderVerdict(synthesis) {
  const deliberation = synthesis.deliberation;
  const decisionRationale = synthesis.decisionRationale;
  const viewpointsCopy = deliberation
    ? deliberation.viewpoints
      .map((viewpoint) => `${viewpoint.agentId.toUpperCase()}: ${viewpoint.primaryClaim}`)
      .join(" ")
    : "";
  const voteCopy = deliberation
    ? deliberation.voteRequired
      ? `Vote (${deliberation.votes.length} seats): ${deliberation.votes.map((vote) => `${vote.agentId}:${vote.ballot}`).join(" | ")}. Winner: ${deliberation.winningDisposition}.`
      : `Agreement reached without escalation vote. Winner: ${deliberation.winningDisposition}.`
    : "";

  verdictTitle.textContent = `Confidence: ${synthesis.confidenceBand.toUpperCase()}`;
  verdictBody.innerHTML = `
    <p>${synthesis.finalAnswer.replace(/\n/g, "<br>")}</p>
    ${deliberation ? `<p><strong>Viewpoints</strong></p><p>${viewpointsCopy}</p>` : ""}
    ${deliberation ? `<p><strong>Decision rule</strong></p><p>${voteCopy}</p><p>${deliberation.consensusSummary}</p>` : ""}
    ${decisionRationale ? `<p><strong>Why this decision</strong></p><p>${decisionRationale.summary}</p><p>${decisionRationale.keyFactors.join(" ")}</p>` : ""}
    <p><strong>Next actions</strong></p>
    <p>${synthesis.nextActions.join(" ")}</p>
  `;
  verdictMeta.innerHTML = "";
  synthesis.supportingClaims.forEach((claim) => {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = `${claim.statement} · ${Math.round(claim.confidence * 100)}%`;
    verdictMeta.appendChild(pill);
  });
}

function applySeatEvent(agentId, event) {
  if (!agentId) return;
  const current = state.agents.get(agentId) ?? initialSeatCard();
  const next = reduceSeatCard(current, event);
  state.agents.set(agentId, next);
  const card = document.querySelector(`#agent-${agentId}`);
  if (card) {
    card.classList.toggle("active", next.active);
    card.classList.toggle("failed", next.failed);
  }
  setAgentCopy(agentId, next.copy);
  setAgentMeta(agentId, next.meta);
}

function setAgentCopy(agentId, text) {
  const element = document.querySelector(`#agent-copy-${agentId}`);
  if (element) {
    element.textContent = text;
  }
}

function appendAgentCopy(agentId, text) {
  const element = document.querySelector(`#agent-copy-${agentId}`);
  if (element) {
    if (element.textContent === WAITING_COPY || element.textContent === "Preparing a proposal...") {
      element.textContent = "";
    }
    element.textContent += text;
    const current = state.agents.get(agentId);
    if (current) current.copy = element.textContent;
  }
}

function setAgentMeta(agentId, items) {
  const meta = document.querySelector(`#agent-meta-${agentId}`);
  if (!meta) {
    return;
  }

  meta.innerHTML = "";
  items.forEach((item) => {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = item;
    meta.appendChild(pill);
  });
}

function addEventCard(title, text) {
  const card = document.createElement("article");
  card.className = "event";
  card.innerHTML = `<strong>${title}</strong><p>${text}</p>`;
  eventsElement.prepend(card);
}

function resetRunState() {
  eventsElement.innerHTML = "";
  verdictTitle.textContent = "Awaiting a run";
  verdictBody.innerHTML = "<p>The final synthesis will appear here once the chamber resolves its first pass.</p>";
  verdictMeta.innerHTML = "";
  for (const agentId of state.agents.keys()) {
    const next = initialSeatCard();
    state.agents.set(agentId, next);
    const card = document.querySelector(`#agent-${agentId}`);
    if (card) {
      card.classList.remove("active");
      card.classList.remove("failed");
    }
    setAgentCopy(agentId, next.copy);
    setAgentMeta(agentId, next.meta);
  }
}