const state = {
  runId: null,
  socket: null,
  agents: new Map(),
  config: null
};

const runtimeMode = document.querySelector("#runtime-mode");
const agentsElement = document.querySelector("#agents");
const eventsElement = document.querySelector("#events");
const verdictTitle = document.querySelector("#verdict-title");
const verdictBody = document.querySelector("#verdict-body");
const verdictMeta = document.querySelector("#verdict-meta");
const runForm = document.querySelector("#run-form");
const submitButton = document.querySelector("#submit-button");

initialize().catch((error) => {
  console.error(error);
  addEventCard("System", "Failed to initialize the interface.");
});

async function initialize() {
  const configResponse = await fetch("/api/config");
  state.config = await configResponse.json();
  runtimeMode.textContent = `${state.config.providerMode.toUpperCase()} mode`;
  renderAgentCards(state.config.agents.filter((agent) => agent.id !== "voxis" || state.config.includeVoxis));
  connectSocket();
}

runForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(runForm);
  const question = String(formData.get("question") ?? "").trim();
  const context = String(formData.get("context") ?? "").trim();
  const mode = String(formData.get("mode") ?? "mock");

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
    body: JSON.stringify({ question, context, mode })
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
    state.agents.set(agent.id, { summary: "Waiting for a proposal..." });
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
      <p class="agent-copy" id="agent-copy-${agent.id}">Waiting for a proposal...</p>
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
      setAgentActive(event.agentId, true);
      setAgentMeta(event.agentId, [`${event.payload.providerName}`, `${event.payload.modelName}`, "Thinking"]);
      addEventCard(`${event.agentId} started`, `Preparing a proposal with ${event.payload.modelName}.`);
      break;
    case "proposal.delta":
      appendAgentCopy(event.agentId, event.payload.delta);
      break;
    case "proposal.completed":
      setAgentActive(event.agentId, false);
      setAgentCopy(event.agentId, event.payload.proposal.summary);
      setAgentMeta(event.agentId, [
        `Confidence ${Math.round(event.payload.proposal.confidence * 100)}%`,
        ...event.payload.proposal.claims.slice(0, 2).map((claim) => claim.statement)
      ]);
      addEventCard(`${event.agentId} proposed`, event.payload.proposal.summary);
      break;
    case "critique.started":
      addEventCard(`${event.agentId} critiques`, `Pressure-testing ${event.payload.targetAgentId}.`);
      break;
    case "critique.completed":
      addEventCard(`${event.agentId} critique`, event.payload.critique.concerns[0]);
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
  verdictTitle.textContent = `Confidence: ${synthesis.confidenceBand.toUpperCase()}`;
  verdictBody.innerHTML = `
    <p>${synthesis.finalAnswer}</p>
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

function setAgentActive(agentId, isActive) {
  const card = document.querySelector(`#agent-${agentId}`);
  if (!card) {
    return;
  }

  card.classList.toggle("active", isActive);
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
    if (element.textContent === "Waiting for a proposal...") {
      element.textContent = "";
    }
    element.textContent += text;
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
  document.querySelectorAll(".agent-card").forEach((card) => card.classList.remove("active"));
  document.querySelectorAll(".agent-copy").forEach((card) => {
    card.textContent = "Waiting for a proposal...";
  });
  document.querySelectorAll("[id^='agent-meta-']").forEach((meta) => {
    meta.innerHTML = "<span class='pill'>Idle</span>";
  });
}