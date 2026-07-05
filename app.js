const storageKey = "shadiFlowStateV1";
const legacyStorageKeys = ["clearScribeFlowStateV2"];
const DEFAULT_TRANSCRIPTION_ENGINE = "mlx-parakeet";
const LIVE_PREVIEW_INTERVAL_MS = 900;
const LIVE_PREVIEW_MIN_MS = 900;
const LIVE_PREVIEW_MAX_MS = 8000;

window.addEventListener("error", (event) => {
  window.clearScribe?.logEvent?.("error", {
    message: String(event.message || "Renderer error").slice(0, 1000),
    source: event.filename || "",
    line: event.lineno || 0,
    column: event.colno || 0,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason || {};
  window.clearScribe?.logEvent?.("unhandledrejection", {
    message: String(reason.message || reason || "Unhandled promise rejection").slice(0, 1000),
    stack: String(reason.stack || "").split("\n").slice(0, 6).join("\n"),
  });
});

const navItems = [
  ["home", "Home"],
  ["insights", "Insights"],
  ["dictionary", "Dictionary"],
  ["snippets", "Snippets"],
  ["style", "Style"],
  ["transforms", "Transforms"],
  ["scratchpad", "Scratchpad"],
];

const styleGroups = {
  personal: {
    label: "Personal messages",
    apps: "Messages, Telegram, Discord, Instagram",
    cards: [
      ["formal", "Formal.", "Caps + Punctuation", "Hey, are you free for lunch tomorrow? Let's do 12 if that works for you."],
      ["casual", "Casual", "Caps + Less punctuation", "hey are you free for lunch tomorrow? let's do 12 if that works for you"],
      ["very-casual", "very casual", "No Caps + Less punctuation", "hey are you free for lunch tomorrow? lets do 12 if that works for you"],
      ["excited", "Excited!", "More exclamations", "Hey! Are you free for lunch tomorrow? Let's do 12 if that works!"],
    ],
  },
  work: {
    label: "Work messages",
    apps: "Slack, Teams, LinkedIn",
    cards: [
      ["formal", "Formal.", "Clear + complete", "Hi Jordan, I can review this by 3 PM and send the notes after."],
      ["casual", "Casual", "Brief + friendly", "Hey Jordan, I can review this by 3 and send notes after."],
      ["concise", "Concise", "Short + direct", "I can review by 3 and send notes after."],
    ],
  },
  email: {
    label: "Email",
    apps: "Mail, Gmail, Outlook",
    cards: [
      ["polished", "Polished", "Subject-ready", "Hi Nora,\n\nI can meet Friday at 3 PM. Does that still work for you?\n\nBest,\nShadi"],
      ["warm", "Warm", "Friendly close", "Hi Nora,\n\nThanks for reaching out. Friday at 3 PM works well for me.\n\nBest,\nShadi"],
      ["brief", "Brief", "Fast reply", "Hi Nora,\n\nFriday at 3 PM works for me.\n\nBest,\nShadi"],
    ],
  },
  other: {
    label: "Other",
    apps: "Docs, prompts, browser fields",
    cards: [
      ["clean", "Clean", "Plain dictation", "Please summarize the notes and include open questions."],
      ["structured", "Structured", "Adds bullets", "Summary:\n- Review the notes\n- List open questions\n- Suggest next steps"],
      ["prompt", "Prompt", "Instruction-ready", "Create a clear summary of these notes with open questions and next steps."],
    ],
  },
  cleanup: {
    label: "Auto Cleanup",
    apps: "Everywhere",
    cards: [
      ["light", "Light cleanup", "Remove fillers", "I checked the draft and sent the notes."],
      ["smart", "Smart cleanup", "Fix wording", "I reviewed the draft and sent the notes."],
      ["strict", "Strict cleanup", "Rewrite awkward phrases", "I reviewed the draft and shared concise notes."],
    ],
  },
};

const settingsSections = [
  "General",
  "System",
  "Vibe coding",
  "Experimental",
  "Account",
  "Team",
  "Plans and Billing",
  "Data and Privacy",
];

const defaultWords = [
  { id: uid(), term: "ShadiFlow", aliases: ["shadi flow", "shady flow"], scope: "personal", correct: true, favorite: true },
  { id: uid(), term: "Wispr Flow", aliases: ["whisper flow", "wispr flow"], scope: "personal", correct: true, favorite: false },
  { id: uid(), term: "Shadi", aliases: ["shady", "shadi"], scope: "personal", correct: true, favorite: false },
  { id: uid(), term: "Supabase", aliases: ["super base", "supa base"], scope: "team", correct: true, favorite: false },
];

const defaultSnippets = [
  { id: uid(), cue: "intro email", body: "Hey, would love to find some time to chat later.", scope: "personal" },
  { id: uid(), cue: "linkedin", body: "https://www.linkedin.com/in/shadi-shalah/", scope: "personal" },
  { id: uid(), cue: "support intro", body: "Thanks for reaching out. I can help with that and will keep this thread updated as I work through it.", scope: "team" },
];

const defaultTransforms = [
  { id: uid(), name: "Polish", prompt: "Improve clarity and conciseness", enabled: true },
  { id: uid(), name: "Prompt Engineer", prompt: "Constructs optimal prompts", enabled: true },
];

const state = loadState();

let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let audioSource = null;
let audioProcessor = null;
let audioChunks = [];
let recordingMimeType = "";
let recordingMode = "";
let wavSampleRate = 0;
let startedAt = 0;
let timerId = null;
let autoStopTimerId = null;
let livePreviewTimerId = null;
let livePreviewInFlight = false;
let livePreviewSeq = 0;
let livePreviewText = "";
let stopInProgress = false;
let activeRecording = { autoInsert: false, source: "workspace" };

const els = {
  nav: document.querySelector("#nav"),
  page: document.querySelector("#page"),
  pageTitle: document.querySelector("#page-title"),
  pageKicker: document.querySelector("#page-kicker"),
  engineState: document.querySelector("#engine-state"),
  flowBar: document.querySelector("#flow-bar"),
  flowMic: document.querySelector("#flow-mic"),
  flowState: document.querySelector("#flow-state"),
  flowLine: document.querySelector("#flow-line"),
  timer: document.querySelector("#timer"),
  wordCount: document.querySelector("#word-count"),
  modal: document.querySelector("#modal"),
  modalTitle: document.querySelector("#modal-title"),
  modalBody: document.querySelector("#modal-body"),
  modalActions: document.querySelector("#modal-actions"),
};

init();

function init() {
  renderNav();
  render();
  bindEvents();
  bindDesktopEvents();
  checkRuntime();
  setFlow("Ready", "Shortcut or mic to dictate anywhere");
  persist();
}

function loadState() {
  try {
    const keys = [storageKey, ...legacyStorageKeys];
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const saved = JSON.parse(raw);
      return normalizeState(saved);
    }
    return normalizeState({});
  } catch {
    return normalizeState({});
  }
}

function normalizeState(saved) {
  return {
    page: saved.page || "home",
    insightsTab: saved.insightsTab || "usage",
    dictionaryTab: saved.dictionaryTab || "all",
    snippetsTab: saved.snippetsTab || "all",
    styleTab: saved.styleTab || "personal",
    selectedStyles: saved.selectedStyles || { personal: "casual", work: "casual", email: "polished", other: "clean", cleanup: "smart" },
    transformsOptIn: saved.transformsOptIn ?? true,
    scratchpadInFlowBar: saved.scratchpadInFlowBar ?? false,
    dictionary: Array.isArray(saved.dictionary) ? saved.dictionary : defaultWords,
    snippets: Array.isArray(saved.snippets) ? saved.snippets : defaultSnippets,
    transforms: Array.isArray(saved.transforms) ? saved.transforms : defaultTransforms,
    notes: Array.isArray(saved.notes) ? saved.notes : [],
    history: Array.isArray(saved.history) ? normalizeHistory(saved.history) : seededHistory(),
    settings: {
      shortcut: saved.settings?.shortcut || "Cmd+Shift+Space",
      microphone: saved.settings?.microphone || "Built-in mic",
      transcriptionEngine: normalizeTranscriptionEngine(saved.settings?.transcriptionEngine),
      dictationLanguage: saved.settings?.dictationLanguage || "en",
      appLanguage: saved.settings?.appLanguage || "English",
      variableRecognition: saved.settings?.variableRecognition ?? false,
      fileTagging: saved.settings?.fileTagging ?? false,
      privacyMode: saved.settings?.privacyMode ?? true,
      cloudSync: saved.settings?.cloudSync ?? false,
      contextAwareness: saved.settings?.contextAwareness ?? true,
      localStorage: saved.settings?.localStorage || "Store data locally",
    },
    account: {
      firstName: saved.account?.firstName || "Shadi",
      lastName: saved.account?.lastName || "Shalah",
      email: saved.account?.email || "shadi.shalah@example.com",
    },
  };
}

function seededHistory() {
  const now = Date.now();
  return [
    createHistory("I want to know if it works.", now - 15 * 60 * 1000, "Desktop"),
    createHistory("This is not as fast as it looks.", now - 24 * 60 * 60 * 1000, "Browser"),
    createHistory("Hello.", now - 2 * 24 * 60 * 60 * 1000, "Messages"),
    createHistory("In reality, this is one of my squeaks this quarter, but with text.", now - 5 * 24 * 60 * 60 * 1000, "Docs"),
  ];
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function logDesktopEvent(event, detail = {}) {
  try {
    window.clearScribe?.logEvent?.(event, detail);
  } catch {
    // Diagnostics should never affect dictation.
  }
}

function resetActiveRecording() {
  stopLivePreview();
  activeRecording = { autoInsert: false, source: "workspace" };
  startedAt = 0;
}

function bindEvents() {
  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  els.flowMic.addEventListener("click", () => toggleRecording({ autoInsert: false, source: "workspace" }));
}

function bindDesktopEvents() {
  window.clearScribe?.onShortcutToggle?.((payload = {}) => {
    toggleRecording({
      autoInsert: Boolean(payload.autoInsert),
      source: payload.source || "global",
    });
  });
  window.clearScribe?.onShortcutStop?.(() => {
    stopRecording({ force: true });
  });
  window.clearScribe?.onShortcutCancel?.(() => {
    cancelRecording();
  });
  window.addEventListener("shadiflow-stop-recording", () => stopRecording({ force: true }));
  window.addEventListener("shadiflow-cancel-recording", () => cancelRecording());
}

async function checkRuntime() {
  try {
    const status = await window.clearScribe?.getStatus?.();
    if (!status) return;
    const backendEngine = normalizeTranscriptionEngine(status.localSpeechEngine || status.transcriptionProvider || "");
    if (backendEngine && backendEngine !== state.settings.transcriptionEngine) {
      state.settings.transcriptionEngine = backendEngine;
      persist();
    }
    const engine = selectedTranscriptionEngine();
    const engineLabel = engine === "mlx-parakeet"
      ? "MLX Parakeet"
      : engine === "mlx-whisper"
        ? "MLX Whisper"
        : status.localWhisperEngine === "mlx-whisper"
          ? "MLX Whisper"
          : "Local Whisper";
    els.engineState.textContent = status.localWhisperReady
      ? `${engineLabel} / ${status.localActiveModel || status.localWhisperModel || "large-v3-turbo"}`
      : `${engineLabel} missing`;
  } catch {
    els.engineState.textContent = "Runtime unavailable";
  }
}

function renderNav() {
  els.nav.innerHTML = navItems
    .map(([id, label]) => `<button class="nav-item ${state.page === id ? "is-active" : ""}" type="button" data-page="${id}">${label}</button>`)
    .join("");
}

function render(options = {}) {
  renderNav();
  const titles = {
    home: ["Home", "Get back into flow"],
    insights: ["Insights", "Understand your voice"],
    dictionary: ["Dictionary", "Spell the way you do"],
    snippets: ["Snippets", "Text you should not re-type"],
    style: ["Style", "Choose how dictation sounds"],
    transforms: ["Transforms", "Rewrite anywhere you write"],
    scratchpad: ["Scratchpad", "Quick thoughts to come back to"],
  };
  const [kicker, title] = titles[state.page] || titles.home;
  els.pageKicker.textContent = kicker;
  els.pageTitle.textContent = title;
  els.page.innerHTML = `${renderLiveTranscriptPanel()}${renderPage(state.page)}`;
  if (options.persist !== false) persist();
}

function renderPage(page) {
  if (page === "insights") return renderInsights();
  if (page === "dictionary") return renderDictionary();
  if (page === "snippets") return renderSnippets();
  if (page === "style") return renderStyle();
  if (page === "transforms") return renderTransforms();
  if (page === "scratchpad") return renderScratchpad();
  return renderHome();
}

function renderHome() {
  const stats = computeStats();
  const groups = groupHistory(state.history);
  const rows = groups
    .map(
      (group) => `
        <div class="date-label">${group.label}</div>
        ${group.items.map(renderHistoryRow).join("")}
      `,
    )
    .join("");

  return `
    <div class="grid-2">
      <section>
        <div class="banner">
          <h2>Working around other people?</h2>
          <p>Use the global shortcut to dictate into any text box. ShadiFlow learns your dictionary, snippets, and style locally.</p>
          <div class="banner-actions">
            <button class="secondary-button" type="button" data-action="start-recording">Try it now</button>
            <button class="secondary-button" type="button" data-page="dictionary">Add vocabulary</button>
          </div>
        </div>
        <div class="home-list">${rows || empty("No dictations yet", "Use the shortcut or Dictate button to create your first entry.")}</div>
      </section>
      <aside class="stat-stack">
        <div class="card"><span class="big-number">${stats.totalWords.toLocaleString()}</span><span class="muted">total words</span></div>
        <div class="card"><span class="big-number">${stats.wpm}</span><span class="muted">wpm</span></div>
        <div class="card"><span class="big-number">${stats.streak}</span><span class="muted">day streak</span></div>
        <div class="card">
          <h3>Your Voice Profile</h3>
          <p class="muted">Unlocks at 2,000 words. Current voice profile is built from your local dictation history.</p>
          <div class="progress"><span style="width:${Math.min(100, Math.round((stats.totalWords / 2000) * 100))}%"></span></div>
        </div>
      </aside>
    </div>
  `;
}

function renderLiveTranscriptPanel() {
  const visible = isRecording() || stopInProgress || livePreviewText;
  if (!visible) return "";
  const title = stopInProgress ? "Finalizing" : "Listening";
  const body = livePreviewText || " ";
  return `
    <section class="live-draft-card ${livePreviewText ? "has-text" : ""}">
      <div class="live-draft-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div>
        <strong>${escapeHTML(title)}</strong>
        <p>${escapeHTML(body)}</p>
      </div>
      <time>${escapeHTML(els.timer?.textContent || "00:00")}</time>
    </section>
  `;
}

function renderHistoryRow(item) {
  return `
    <article class="history-row">
      <time>${formatTime(item.createdAt)}</time>
      <p>${escapeHTML(item.text)}</p>
      <div class="row-actions">
        <button class="mini-button" type="button" data-action="copy-history" data-id="${item.id}">Copy</button>
        <button class="mini-button" type="button" data-action="delete-history" data-id="${item.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderInsights() {
  const tabs = [
    ["usage", "Your Usage"],
    ["voice", "Your Voice"],
    ["leaderboard", "Leaderboard"],
  ];
  const stats = computeStats();
  return `
    ${renderTabs(tabs, state.insightsTab, "insights-tab")}
    ${state.insightsTab === "voice" ? renderVoiceInsights(stats) : state.insightsTab === "leaderboard" ? renderLeaderboard() : renderUsageInsights(stats)}
  `;
}

function renderUsageInsights(stats) {
  const usage = appUsage();
  return `
    <div class="grid-4">
      <div class="metric-card card"><span class="big-number">${stats.wpm}</span><span class="muted">words per minute</span><div class="progress"><span style="width:${Math.min(100, stats.wpm)}%"></span></div></div>
      <div class="metric-card card"><span class="big-number">${stats.fixes}</span><span class="muted">fixes made</span></div>
      <div class="metric-card card"><span class="big-number">${stats.totalWords.toLocaleString()}</span><span class="muted">total words dictated</span><div class="progress"><span style="width:${Math.min(100, Math.round((stats.totalWords / 2000) * 100))}%"></span></div></div>
      <div class="metric-card card"><span class="big-number">${stats.streak}</span><span class="muted">day streak</span></div>
    </div>
    <div class="grid-2" style="margin-top:18px">
      <section class="card">
        <h3>Desktop usage</h3>
        ${usage.map((row) => `<div class="usage-row"><span>${escapeHTML(row.app)}</span><div class="progress"><span style="width:${row.percent}%"></span></div><strong>${row.percent}%</strong></div>`).join("")}
      </section>
      <section class="card">
        <h3>Streak map</h3>
        <div class="heatmap">${Array.from({ length: 126 }, (_, index) => `<i class="hot-${(index + stats.streak) % 4}"></i>`).join("")}</div>
      </section>
    </div>
  `;
}

function renderVoiceInsights(stats) {
  const remaining = Math.max(0, 2000 - stats.totalWords);
  return `
    <section class="card" style="text-align:center; padding:44px">
      <h2>Unlocks in ${remaining.toLocaleString()} words</h2>
      <p class="muted">We will build a local voice profile from your phrasing, vocabulary, and style choices.</p>
    </section>
    <div class="grid-3" style="margin-top:18px">
      <div class="card"><h3>Voice Profile</h3><p class="muted">Your common sentence patterns, tone, and cleanup preferences.</p></div>
      <div class="card"><h3>Catchphrase</h3><p>${escapeHTML(favoritePhrase())}</p></div>
      <div class="card"><h3>Peak time and place</h3><p class="muted">Most entries are created from ${topApp()} during evening sessions.</p></div>
    </div>
  `;
}

function renderLeaderboard() {
  const rows = ["You", "Teammate", "Product", "Support", "Sales"];
  return `
    <section class="table-card card">
      <h3>Team leaderboard</h3>
      ${rows.map((name, index) => `<div class="list-row"><strong>${index + 1}</strong><p>${escapeHTML(name)}</p><strong>${(23000 - index * 3900).toLocaleString()}</strong></div>`).join("")}
      <div class="empty-state"><div><h2>Upgrade to view leaderboard</h2><p>Team leaderboards need a shared workspace. Local ranking data is mocked until a team backend exists.</p></div></div>
    </section>
  `;
}

function renderDictionary() {
  const items = filteredScoped(state.dictionary, state.dictionaryTab);
  return `
    <div class="toolbar">
      <div class="toolbar-left">${renderTabs([["all", "All"], ["personal", "Personal"], ["team", "Shared with team"]], state.dictionaryTab, "dictionary-tab")}</div>
      <div class="toolbar-right">
        <button class="icon-button" type="button" data-action="sort-dictionary" title="Sort">A</button>
        <button class="icon-button" type="button" data-action="refresh">R</button>
        <button class="primary-button" type="button" data-action="add-word">Add new</button>
      </div>
    </div>
    <div class="promo-card">
      <h2>ShadiFlow spells the way you do.</h2>
      <p>Add personal terms, names, company jargon, client names, and industry-specific language.</p>
      <div class="chip-row">
        <button class="chip" type="button" data-action="add-word">Add new word</button>
        ${state.dictionary.slice(0, 5).map((word) => `<span class="chip">${escapeHTML(word.term)}</span>`).join("")}
      </div>
    </div>
    <section class="table-card card">
      ${items.length ? items.map(renderWordRow).join("") : empty("No words here", "Add vocabulary or switch tabs.")}
    </section>
  `;
}

function renderWordRow(word) {
  return `
    <article class="list-row">
      <strong>${escapeHTML(word.term)}</strong>
      <p class="muted">${escapeHTML((word.aliases || []).join(", "))}</p>
      <div class="row-actions">
        <button class="mini-button" type="button" data-action="edit-word" data-id="${word.id}">Edit</button>
        <button class="mini-button" type="button" data-action="toggle-word-scope" data-id="${word.id}">${word.scope === "team" ? "Personal" : "Share"}</button>
        <button class="mini-button" type="button" data-action="delete-word" data-id="${word.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderSnippets() {
  const items = filteredScoped(state.snippets, state.snippetsTab);
  return `
    <div class="toolbar">
      <div class="toolbar-left">${renderTabs([["all", "All"], ["personal", "Personal"], ["team", "Shared with team"]], state.snippetsTab, "snippets-tab")}</div>
      <div class="toolbar-right">
        <button class="icon-button" type="button" data-action="sort-snippets" title="Sort">A</button>
        <button class="icon-button" type="button" data-action="refresh">R</button>
        <button class="primary-button" type="button" data-action="add-snippet">Add new</button>
      </div>
    </div>
    <div class="promo-card">
      <h2>The stuff you should not have to re-type.</h2>
      <p>Save text you type often, then say the cue word to drop it in instantly.</p>
      <div class="chip-row">
        <button class="chip" type="button" data-action="add-snippet">Add new snippet</button>
        ${state.snippets.slice(0, 5).map((snippet) => `<span class="chip">${escapeHTML(snippet.cue)}</span>`).join("")}
      </div>
    </div>
    <section class="table-card card">
      ${items.length ? items.map(renderSnippetRow).join("") : empty("No snippets here", "Create a reusable block of text.")}
    </section>
  `;
}

function renderSnippetRow(snippet) {
  return `
    <article class="list-row">
      <strong>${escapeHTML(snippet.cue)}</strong>
      <p>${escapeHTML(snippet.body)}</p>
      <div class="row-actions">
        <button class="mini-button" type="button" data-action="copy-snippet" data-id="${snippet.id}">Copy</button>
        <button class="mini-button" type="button" data-action="edit-snippet" data-id="${snippet.id}">Edit</button>
        <button class="mini-button" type="button" data-action="delete-snippet" data-id="${snippet.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderStyle() {
  const group = styleGroups[state.styleTab];
  return `
    ${renderTabs(Object.entries(styleGroups).map(([id, value]) => [id, value.label]), state.styleTab, "style-tab")}
    <div class="banner">
      <h2>This style applies in ${group.label.toLowerCase()}</h2>
      <p>Formatting applies after transcription. Background dictation stays plain unless you run a transform.</p>
      <p class="muted">${escapeHTML(group.apps)}</p>
    </div>
    <div class="grid-4" style="margin-top:18px">
      ${group.cards.map(renderStyleCard).join("")}
    </div>
  `;
}

function renderStyleCard(card) {
  const [id, name, helper, preview] = card;
  const active = state.selectedStyles[state.styleTab] === id;
  return `
    <button class="style-card ${active ? "is-active" : ""}" type="button" data-action="select-style" data-style="${id}">
      <div><h2>${escapeHTML(name)}</h2><p class="muted">${escapeHTML(helper)}</p></div>
      <div class="message-preview">${escapeHTML(preview).replace(/\n/g, "<br>")}</div>
      <span class="avatar">J</span>
    </button>
  `;
}

function renderTransforms() {
  return `
    <div class="toolbar">
      <div class="toolbar-left"><h2>Transforms <span class="engine-pill">Beta</span></h2></div>
      <div class="toolbar-right">
        <span class="muted">Opt in</span>
        <button class="toggle ${state.transformsOptIn ? "is-on" : ""}" type="button" data-action="toggle-transforms"></button>
        <button class="primary-button" type="button" data-action="add-transform">Create New</button>
      </div>
    </div>
    <div class="banner">
      <h2>Transform works anywhere you write</h2>
      <p>Apply a transform to rewrite, clean up, or structure text after dictation.</p>
      <div class="banner-actions">
        <button class="secondary-button" type="button" data-action="try-transform">Try it out</button>
        <button class="secondary-button" type="button" data-action="how-transforms">How it works</button>
      </div>
    </div>
    <div class="toolbar" style="margin-top:18px"><h2>My Transforms</h2><button class="ghost-button" type="button" data-action="reset-transforms">Reset to defaults</button></div>
    <div class="grid-3">
      ${state.transforms.map((transform) => `
        <article class="card">
          <h3>${escapeHTML(transform.name)}</h3>
          <p class="muted">${escapeHTML(transform.prompt)}</p>
          <div class="row-actions">
            <button class="mini-button" type="button" data-action="run-transform" data-id="${transform.id}">Run</button>
            <button class="mini-button" type="button" data-action="edit-transform" data-id="${transform.id}">Edit</button>
            <button class="mini-button" type="button" data-action="delete-transform" data-id="${transform.id}">Delete</button>
          </div>
        </article>
      `).join("")}
      <button class="card" type="button" data-action="add-transform"><h3>Create your own</h3><p class="muted">Upload your own prompt.</p></button>
    </div>
  `;
}

function renderScratchpad() {
  return `
    <div class="toolbar">
      <div class="toolbar-left"><h2>Scratchpad <span class="engine-pill">Beta</span></h2></div>
      <div class="toolbar-right">
        <span class="muted">Add to Flow Bar</span>
        <button class="toggle ${state.scratchpadInFlowBar ? "is-on" : ""}" type="button" data-action="toggle-scratchpad-flow"></button>
        <button class="primary-button" type="button" data-action="add-note">Start new note</button>
      </div>
    </div>
    <div class="banner">
      <h2>For quick thoughts you want to come back to</h2>
      <p>Drop a to-do list, paste a message before sending it, brainstorm, or save a rough transcript.</p>
      <div class="banner-actions"><button class="secondary-button" type="button" data-action="add-note">Start new note</button></div>
    </div>
    <div class="toolbar" style="margin-top:18px"><h2>Recents</h2><input class="search-input" id="note-search" placeholder="Search notes" /></div>
    <section class="table-card card">
      ${state.notes.length ? state.notes.map(renderNoteRow).join("") : empty("No notes found", "Scratchpad notes you create will appear here.")}
    </section>
  `;
}

function renderNoteRow(note) {
  return `
    <article class="list-row">
      <time>${formatDate(note.updatedAt)}</time>
      <p>${escapeHTML(note.title || note.body.slice(0, 80) || "Untitled note")}</p>
      <div class="row-actions">
        <button class="mini-button" type="button" data-action="edit-note" data-id="${note.id}">Open</button>
        <button class="mini-button" type="button" data-action="delete-note" data-id="${note.id}">Delete</button>
      </div>
    </article>
  `;
}

function renderTabs(tabs, active, kind) {
  return `<div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${active === id ? "is-active" : ""}" type="button" data-action="${kind}" data-tab="${id}">${escapeHTML(label)}</button>`).join("")}</div>`;
}

function handleClick(event) {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) {
    state.page = pageButton.dataset.page;
    render();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;

  if (action === "start-recording") toggleRecording({ autoInsert: false, source: "workspace" });
  else if (action === "open-settings") openSettingsModal();
  else if (action === "help") notify("ShadiFlow is running locally. Use Cmd+Shift+Space to dictate anywhere.");
  else if (action === "invite") notify("Team invites are local-only in this build.");
  else if (action === "refer") notify("Referral copied as a placeholder.");
  else if (action === "refresh") render();
  else if (action === "insights-tab") { state.insightsTab = button.dataset.tab; render(); }
  else if (action === "dictionary-tab") { state.dictionaryTab = button.dataset.tab; render(); }
  else if (action === "snippets-tab") { state.snippetsTab = button.dataset.tab; render(); }
  else if (action === "style-tab") { state.styleTab = button.dataset.tab; render(); }
  else if (action === "select-style") { state.selectedStyles[state.styleTab] = button.dataset.style; render(); }
  else if (action === "add-word") openWordModal();
  else if (action === "edit-word") openWordModal(id);
  else if (action === "delete-word") deleteItem("dictionary", id);
  else if (action === "toggle-word-scope") toggleScope("dictionary", id);
  else if (action === "sort-dictionary") { state.dictionary.sort((a, b) => a.term.localeCompare(b.term)); render(); }
  else if (action === "add-snippet") openSnippetModal();
  else if (action === "edit-snippet") openSnippetModal(id);
  else if (action === "delete-snippet") deleteItem("snippets", id);
  else if (action === "copy-snippet") copyValue(findById(state.snippets, id)?.body || "");
  else if (action === "sort-snippets") { state.snippets.sort((a, b) => a.cue.localeCompare(b.cue)); render(); }
  else if (action === "copy-history") copyValue(findById(state.history, id)?.text || "");
  else if (action === "delete-history") deleteItem("history", id);
  else if (action === "toggle-transforms") { state.transformsOptIn = !state.transformsOptIn; render(); }
  else if (action === "add-transform") openTransformModal();
  else if (action === "edit-transform") openTransformModal(id);
  else if (action === "delete-transform") deleteItem("transforms", id);
  else if (action === "reset-transforms") { state.transforms = defaultTransforms.map((item) => ({ ...item, id: uid() })); render(); }
  else if (action === "run-transform" || action === "try-transform") openRunTransformModal(id);
  else if (action === "how-transforms") notify("Pick text, choose a transform, and ShadiFlow rewrites it locally.");
  else if (action === "toggle-scratchpad-flow") { state.scratchpadInFlowBar = !state.scratchpadInFlowBar; render(); }
  else if (action === "add-note") openNoteModal();
  else if (action === "edit-note") openNoteModal(id);
  else if (action === "delete-note") deleteItem("notes", id);
}

function handleChange(event) {
  if (event.target.matches("[data-setting]")) {
    state.settings[event.target.dataset.setting] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    persist();
    if (event.target.dataset.setting === "transcriptionEngine") saveDesktopRuntimeSettings();
  }
  if (event.target.matches("[data-account]")) {
    state.account[event.target.dataset.account] = event.target.value;
    persist();
  }
}

function openWordModal(id = "") {
  const word = findById(state.dictionary, id) || { term: "", aliases: [], scope: "personal", correct: true };
  openModal("Add to vocabulary", `
    <div class="form-grid">
      <label>Preferred spelling<input class="field" id="word-term" value="${escapeAttr(word.term)}" /></label>
      <label>Spoken aliases<input class="field" id="word-aliases" value="${escapeAttr((word.aliases || []).join(", "))}" /></label>
      <label>Scope<select class="select-field" id="word-scope"><option value="personal" ${word.scope !== "team" ? "selected" : ""}>Personal</option><option value="team" ${word.scope === "team" ? "selected" : ""}>Shared with team</option></select></label>
      <label><input type="checkbox" id="word-correct" ${word.correct ? "checked" : ""} /> Correct misspellings automatically</label>
    </div>
  `, "Save word", () => {
    const next = {
      id: id || uid(),
      term: value("#word-term"),
      aliases: value("#word-aliases").split(",").map((part) => part.trim()).filter(Boolean),
      scope: value("#word-scope"),
      correct: document.querySelector("#word-correct").checked,
      favorite: word.favorite || false,
    };
    if (!next.term) return false;
    upsert("dictionary", next);
    return true;
  });
}

function openSnippetModal(id = "") {
  const snippet = findById(state.snippets, id) || { cue: "", body: "", scope: "personal" };
  openModal("Add snippet", `
    <div class="form-grid">
      <label>Shortcut phrase<input class="field" id="snippet-cue" value="${escapeAttr(snippet.cue)}" /></label>
      <label>Expansion<textarea class="field" id="snippet-body">${escapeHTML(snippet.body)}</textarea></label>
      <label>Scope<select class="select-field" id="snippet-scope"><option value="personal" ${snippet.scope !== "team" ? "selected" : ""}>Personal</option><option value="team" ${snippet.scope === "team" ? "selected" : ""}>Shared with team</option></select></label>
    </div>
  `, "Save snippet", () => {
    const next = { id: id || uid(), cue: value("#snippet-cue"), body: value("#snippet-body"), scope: value("#snippet-scope") };
    if (!next.cue || !next.body) return false;
    upsert("snippets", next);
    return true;
  });
}

function openTransformModal(id = "") {
  const transform = findById(state.transforms, id) || { name: "", prompt: "", enabled: true };
  openModal("Transform", `
    <div class="form-grid">
      <label>Name<input class="field" id="transform-name" value="${escapeAttr(transform.name)}" /></label>
      <label>Instruction<textarea class="field" id="transform-prompt">${escapeHTML(transform.prompt)}</textarea></label>
    </div>
  `, "Save transform", () => {
    const next = { id: id || uid(), name: value("#transform-name"), prompt: value("#transform-prompt"), enabled: true };
    if (!next.name || !next.prompt) return false;
    upsert("transforms", next);
    return true;
  });
}

function openRunTransformModal(id = "") {
  const transform = findById(state.transforms, id) || state.transforms[0];
  openModal(transform ? transform.name : "Run transform", `
    <div class="form-grid">
      <label>Text to transform<textarea class="field" id="transform-input" placeholder="Paste text here"></textarea></label>
      <label>Result<textarea class="field" id="transform-output" readonly></textarea></label>
    </div>
  `, "Run", () => {
    const input = value("#transform-input");
    document.querySelector("#transform-output").value = applyTransform(input, transform);
    return false;
  }, { secondary: "Copy result", secondaryAction: () => copyValue(value("#transform-output")) });
}

function openNoteModal(id = "") {
  const note = findById(state.notes, id) || { title: "", body: "" };
  openModal("Scratchpad note", `
    <div class="form-grid">
      <label>Title<input class="field" id="note-title" value="${escapeAttr(note.title || "")}" /></label>
      <label>Note<textarea class="field" id="note-body">${escapeHTML(note.body || "")}</textarea></label>
    </div>
  `, "Save note", () => {
    const next = { id: id || uid(), title: value("#note-title"), body: value("#note-body"), updatedAt: Date.now() };
    if (!next.title && !next.body) return false;
    upsert("notes", next);
    return true;
  });
}

function openSettingsModal(active = "General") {
  let activeSection = active;
  const renderSettings = () => {
    openModal("Settings", `
      <div class="settings-layout">
        <nav class="settings-nav">
          ${settingsSections.map((section) => `<button class="nav-item ${activeSection === section ? "is-active" : ""}" type="button" data-settings-section="${escapeAttr(section)}">${escapeHTML(section)}</button>`).join("")}
        </nav>
        <section class="settings-panel">${settingsSectionHTML(activeSection)}</section>
      </div>
    `, "Done", () => true, { wide: true });
    document.querySelectorAll("[data-settings-section]").forEach((button) => {
      button.addEventListener("click", () => {
        activeSection = button.dataset.settingsSection;
        renderSettings();
      });
    });
  };
  renderSettings();
}

function settingsSectionHTML(section) {
  if (section === "General") {
    return `
      ${settingRow("Shortcuts", "Hold fn and speak. Global shortcut is handled by macOS.", `<button class="secondary-button" type="button">Change</button>`)}
      ${settingRow("Microphone", state.settings.microphone, `<button class="secondary-button" type="button" data-action="start-recording">Test</button>`)}
      ${settingRow("Speech Engine", "Use Parakeet for fast English/Spanish dictation; Whisper stays available as fallback.", `<select class="select-field wide-select" data-setting="transcriptionEngine"><option value="mlx-parakeet" ${selected("mlx-parakeet", state.settings.transcriptionEngine)}>MLX Parakeet TDT 0.6B v3</option><option value="mlx-whisper" ${selected("mlx-whisper", state.settings.transcriptionEngine)}>MLX Whisper Large V3 Turbo</option><option value="openai-whisper" ${selected("openai-whisper", state.settings.transcriptionEngine)}>OpenAI Whisper CLI</option></select>`)}
      ${settingRow("Dictation Language", "Use Auto when switching between languages.", `<select class="select-field" data-setting="dictationLanguage"><option value="auto" ${selected("auto", state.settings.dictationLanguage)}>Auto</option><option value="en" ${selected("en", state.settings.dictationLanguage)}>English</option><option value="es" ${selected("es", state.settings.dictationLanguage)}>Spanish</option><option value="fr" ${selected("fr", state.settings.dictationLanguage)}>French</option><option value="de" ${selected("de", state.settings.dictationLanguage)}>German</option><option value="it" ${selected("it", state.settings.dictationLanguage)}>Italian</option><option value="pt" ${selected("pt", state.settings.dictationLanguage)}>Portuguese</option><option value="ar" ${selected("ar", state.settings.dictationLanguage)}>Arabic</option></select>`)}
      ${settingRow("App Language", "Preferred app UI language.", `<select class="select-field" data-setting="appLanguage"><option>English</option><option>Spanish</option><option>Arabic</option></select>`)}
    `;
  }
  if (section === "Vibe coding") {
    return `
      ${settingRow("Variable recognition", "Better understands variables in VS Code, Cursor, and Windsurf.", `<button class="toggle ${state.settings.variableRecognition ? "is-on" : ""}" type="button" data-toggle-setting="variableRecognition"></button>`)}
      ${settingRow("File tagging in chat", "Automatically tags files in your IDE.", `<button class="toggle ${state.settings.fileTagging ? "is-on" : ""}" type="button" data-toggle-setting="fileTagging"></button>`)}
    `;
  }
  if (section === "Account") {
    return `
      ${settingRow("First name", "", `<input class="field" data-account="firstName" value="${escapeAttr(state.account.firstName)}" />`)}
      ${settingRow("Last name", "", `<input class="field" data-account="lastName" value="${escapeAttr(state.account.lastName)}" />`)}
      ${settingRow("Email", "", `<input class="field" data-account="email" value="${escapeAttr(state.account.email)}" />`)}
      <button class="secondary-button" type="button">Sign out</button>
    `;
  }
  if (section === "Plans and Billing") {
    return `
      ${settingRow("ShadiFlow Pro", "Local build. No billing is connected.", `<button class="primary-button" type="button">Explore features</button>`)}
      ${settingRow("Enterprise", "SSO, team-wide data controls, and more would need a backend.", `<button class="secondary-button" type="button">Upgrade</button>`)}
    `;
  }
  if (section === "Data and Privacy") {
    return `
      ${settingRow("Privacy Mode", "Dictation data is kept local in this build.", `<button class="toggle ${state.settings.privacyMode ? "is-on" : ""}" type="button" data-toggle-setting="privacyMode"></button>`)}
      ${settingRow("Cloud Sync", "Disabled unless a server is added.", `<button class="toggle ${state.settings.cloudSync ? "is-on" : ""}" type="button" data-toggle-setting="cloudSync"></button>`)}
      ${settingRow("Context awareness", "Use local app context for dictionary and snippets.", `<button class="toggle ${state.settings.contextAwareness ? "is-on" : ""}" type="button" data-toggle-setting="contextAwareness"></button>`)}
      ${settingRow("Local data storage", state.settings.localStorage, `<select class="select-field" data-setting="localStorage"><option>Store data locally</option><option>Ask every time</option></select>`)}
    `;
  }
  return `
    ${settingRow(section, "This section is wired locally and ready for product-specific options.", `<button class="secondary-button" type="button">Configure</button>`)}
  `;
}

function settingRow(title, detail, control) {
  return `<div class="settings-row"><div><strong>${escapeHTML(title)}</strong><p class="muted">${escapeHTML(detail || "")}</p></div><div>${control}</div></div>`;
}

function openModal(title, body, submitLabel, onSubmit, options = {}) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = body;
  els.modalActions.innerHTML = `
    ${options.secondary ? `<button class="secondary-button" type="button" id="modal-secondary">${escapeHTML(options.secondary)}</button>` : ""}
    <button class="secondary-button" value="cancel" type="submit">Cancel</button>
    <button class="primary-button" type="button" id="modal-submit">${escapeHTML(submitLabel)}</button>
  `;
  els.modal.style.width = options.wide ? "min(980px, calc(100vw - 40px))" : "";
  if (!els.modal.open) els.modal.showModal();
  document.querySelectorAll("[data-toggle-setting]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.toggleSetting;
      state.settings[key] = !state.settings[key];
      persist();
      openSettingsModal(document.querySelector(".settings-nav .is-active")?.dataset.settingsSection || "General");
    });
  });
  document.querySelector("#modal-submit").onclick = () => {
    if (onSubmit() === false) return;
    persist();
    els.modal.close();
    render();
  };
  const secondary = document.querySelector("#modal-secondary");
  if (secondary && options.secondaryAction) secondary.onclick = options.secondaryAction;
}

function toggleRecording(options = {}) {
  if (isRecording()) {
    stopRecording({ force: true });
    return;
  }
  if (stopInProgress) return;
  startRecording(options);
}

async function startRecording(options = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    notify("Microphone recording is not available.");
    publishOverlay({ type: "error", title: "Recorder unavailable", detail: "Microphone recording is not available." });
    logDesktopEvent("recording:start-unavailable", { reason: "missing-media-devices" });
    return;
  }

  try {
    stopInProgress = false;
    activeRecording = { autoInsert: Boolean(options.autoInsert), source: options.source || "workspace" };
    logDesktopEvent("recording:start-request", activeRecording);
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioChunks = [];
    recordingMode = "";

    if (window.AudioContext || window.webkitAudioContext) {
      await startWavRecorder(mediaStream);
    } else if (window.MediaRecorder) {
      startMediaRecorder(mediaStream);
    } else {
      throw new Error("This system cannot start an audio recorder.");
    }

    startedAt = Date.now();
    timerId = window.setInterval(updateTimer, 250);
    autoStopTimerId = window.setTimeout(() => {
      if (isRecording()) stopRecording({ force: true });
    }, 90 * 1000);
    els.flowBar.classList.add("is-recording");
    setFlow("Listening", activeRecording.autoInsert ? "Press shortcut again to insert" : "Press mic again to save");
    publishOverlay({ type: "recording", elapsed: "00:00" });
    logDesktopEvent("recording:started", {
      ...activeRecording,
      mode: recordingMode,
      sampleRate: wavSampleRate || 0,
      mimeType: recordingMimeType || "",
    });
    startLivePreview();
  } catch (error) {
    stopInProgress = false;
    setFlow("Mic unavailable", error.message || "Permission denied");
    publishOverlay({ type: "error", title: "Mic unavailable", detail: error.message || "Permission denied" });
    logDesktopEvent("recording:start-failed", { message: error.message || String(error) });
    cleanupAudioRecorder();
    resetActiveRecording();
  }
}

function stopRecording(options = {}) {
  const force = Boolean(options.force);
  const hasBufferedAudio = audioChunks.length > 0;
  logDesktopEvent("recording:stop-request", {
    force,
    hasBufferedAudio,
    mode: recordingMode,
    isRecording: isRecording(),
    autoInsert: activeRecording.autoInsert,
    source: activeRecording.source,
  });

  if (stopInProgress) return;
  if (!isRecording() && !force) return;
  if (!isRecording() && force && !hasBufferedAudio && !recordingMode) {
    publishOverlay({ type: "idle" });
    resetActiveRecording();
    return;
  }

  stopInProgress = true;
  stopLivePreview({ keepText: true });
  els.flowBar.classList.remove("is-recording");
  setFlow("Transcribing", livePreviewText || "Finalizing local transcript");
  publishOverlay({ type: "transcribing", elapsed: els.timer.textContent, text: livePreviewText });
  window.clearInterval(timerId);
  timerId = null;
  window.clearTimeout(autoStopTimerId);
  autoStopTimerId = null;
  updateTimer(true);

  if (recordingMode === "wav" || recordingMimeType === "audio/wav") {
    handleWavRecordingStopped();
    return;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.requestData();
    } catch {
      // Recorder backend may not support this right before stop.
    }
    mediaRecorder.stop();
    return;
  }

  if (recordingMode === "media-recorder" && hasBufferedAudio) {
    handleMediaRecorderStopped();
    return;
  }

  stopInProgress = false;
  publishOverlay({ type: "idle" });
  resetActiveRecording();
}

function cancelRecording() {
  const hadActiveRecording = isRecording() || Boolean(recordingMode || audioChunks.length || mediaStream || stopInProgress);
  if (!hadActiveRecording) {
    publishOverlay({ type: "idle" });
    return;
  }

  window.clearInterval(timerId);
  timerId = null;
  window.clearTimeout(autoStopTimerId);
  autoStopTimerId = null;
  els.flowBar.classList.remove("is-recording");
  stopLivePreview();
  cleanupAudioRecorder();
  setFlow("Ready", "Shortcut or mic to dictate anywhere");
  publishOverlay({ type: "idle" });
  logDesktopEvent("recording:cancelled", { autoInsert: activeRecording.autoInsert, source: activeRecording.source });
  resetActiveRecording();
}

function isRecording() {
  return Boolean(
    (recordingMode === "wav" && audioProcessor) ||
      (mediaRecorder && mediaRecorder.state !== "inactive"),
  );
}

async function startWavRecorder(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass();
  wavSampleRate = audioContext.sampleRate || 48000;
  audioSource = audioContext.createMediaStreamSource(stream);
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  recordingMimeType = "audio/wav";
  recordingMode = "wav";

  audioProcessor.onaudioprocess = (event) => {
    if (recordingMode !== "wav") return;
    const input = event.inputBuffer.getChannelData(0);
    audioChunks.push(new Float32Array(input));
  };

  audioSource.connect(audioProcessor);
  audioProcessor.connect(audioContext.destination);
  if (audioContext.state === "suspended") await audioContext.resume();
}

function startMediaRecorder(stream) {
  const mimeType = chooseAudioMimeType();
  recordingMimeType = mimeType || "";
  recordingMode = "media-recorder";
  mediaRecorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType, audioBitsPerSecond: 192000 } : { audioBitsPerSecond: 192000 },
  );
  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size) audioChunks.push(event.data);
  };
  mediaRecorder.onstop = handleMediaRecorderStopped;
  mediaRecorder.start();
}

async function handleWavRecordingStopped() {
  const chunks = audioChunks;
  const sampleRate = wavSampleRate || 48000;
  const audioStats = measureAudioChunks(chunks);
  cleanupAudioRecorder();
  const wavBuffer = encodeWav(chunks, sampleRate);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  await finishRecording(blob, audioStats);
}

async function handleMediaRecorderStopped() {
  const mimeType = mediaRecorder?.mimeType || recordingMimeType || "audio/webm";
  const blob = new Blob(audioChunks, { type: mimeType });
  cleanupAudioRecorder();
  await finishRecording(blob);
}

async function finishRecording(blob, audioStats = null) {
  const recordedMs = Date.now() - startedAt;
  const recording = { ...activeRecording };
  logDesktopEvent("recording:finish-start", {
    ...recording,
    bytes: blob.size,
    mimeType: blob.type || "",
    recordedMs,
    audioStats,
  });
  if (blob.size < 1400 || recordedMs < 700) {
    setFlow("Too short", "Hold a little longer", { words: 0 });
    publishOverlay({ type: "error", title: "Too short", detail: "Hold a little longer." });
    logDesktopEvent("recording:finish-too-short", { ...recording, bytes: blob.size, recordedMs });
    resetActiveRecording();
    return;
  }

  try {
    logDesktopEvent("recording:transcribe-start", {
      ...recording,
      bytes: blob.size,
      mimeType: blob.type || "",
      language: selectedWhisperLanguage() || "auto",
      engine: selectedTranscriptionEngine(),
      audioStats,
    });
    const data = await window.clearScribe.transcribe({
      audioBuffer: await blob.arrayBuffer(),
      mimeType: blob.type || "audio/webm",
      filename: `shadiflow-${Date.now()}${audioExtensionForMime(blob.type)}`,
      language: selectedWhisperLanguage(),
      engine: selectedTranscriptionEngine(),
      audioStats,
    });
    const transcript = String(data.text || "").trim();
    logDesktopEvent("recording:transcribe-result", {
      ...recording,
      textLength: transcript.length,
      transcriptPreview: transcriptPreview(transcript),
      durationMs: data.durationMs || 0,
      workerDurationMs: data.workerDurationMs || 0,
      audioPrepDurationMs: data.audioPrepDurationMs || 0,
      engine: data.engine || selectedTranscriptionEngine(),
      model: data.model || "",
      languageFallback: Boolean(data.languageFallback),
    });
    if (!hasMeaningfulSpeech(transcript)) {
      logDesktopEvent("recording:rejected-transcript", {
        ...recording,
        stage: "raw",
        transcriptPreview: transcriptPreview(transcript),
        audioStats,
      });
      throw new Error("No speech detected");
    }

    const text = prepareTranscriptText(transcript);
    if (!hasMeaningfulSpeech(text)) {
      logDesktopEvent("recording:rejected-transcript", {
        ...recording,
        stage: "prepared",
        transcriptPreview: transcriptPreview(text),
        rawPreview: transcriptPreview(transcript),
        audioStats,
      });
      throw new Error("No speech detected");
    }
    const entry = createHistory(text, Date.now(), recording.autoInsert ? "Anywhere" : "ShadiFlow", data.durationMs);
    state.history.unshift(entry);

    if (recording.autoInsert) {
      let result;
      try {
        result = await window.clearScribe.insertText(text, { background: true });
      } catch (error) {
        result = {
          ok: false,
          copied: true,
          message: "Text copied to clipboard, but automatic paste failed.",
          error,
        };
      }
      logDesktopEvent("recording:insert-result", {
        ...recording,
        ok: Boolean(result?.ok),
        copied: Boolean(result?.copied),
        permissionRequired: Boolean(result?.permissionRequired),
        message: result?.message || "",
        textLength: text.length,
      });
      if (result?.ok === false) {
        publishOverlay({
          type: "error",
          title: result.permissionRequired ? "Enable automatic paste" : "Could not paste",
          detail: result.message || "Text copied to clipboard.",
          text,
          permissionRequired: Boolean(result.permissionRequired),
        });
      } else {
        publishOverlay({ type: "inserted", detail: `${entry.words} words / ${data.durationMs}ms`, text });
      }
    } else {
      notify(`Saved: ${text}`);
    }
    setFlow("Ready", `${entry.words} words / ${data.durationMs}ms`);
    resetActiveRecording();
    render();
  } catch (error) {
    console.error(error);
    const detail = friendlyTranscriptionError(error, audioStats);
    setFlow("Transcription unavailable", detail, { words: 0 });
    publishOverlay({ type: "error", title: "Transcription unavailable", detail });
    logDesktopEvent("recording:finish-failed", {
      ...recording,
      message: error.message || String(error),
      audioStats,
    });
    resetActiveRecording();
  }
}

function chooseAudioMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function audioExtensionForMime(mimeType = "") {
  const type = mimeType.toLowerCase();
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("wav")) return ".wav";
  return ".webm";
}

function selectedWhisperLanguage() {
  return state.settings.dictationLanguage === "auto" ? "" : state.settings.dictationLanguage;
}

function selectedTranscriptionEngine() {
  return normalizeTranscriptionEngine(state.settings.transcriptionEngine);
}

function normalizeTranscriptionEngine(engine) {
  const value = String(engine || "").trim().toLowerCase();
  if (value === "parakeet" || value === "mlx-parakeet" || value === "parakeet-mlx") return "mlx-parakeet";
  if (value === "openai" || value === "openai-whisper" || value === "whisper") return "openai-whisper";
  return DEFAULT_TRANSCRIPTION_ENGINE;
}

async function saveDesktopRuntimeSettings() {
  try {
    const current = await window.clearScribe?.getSettings?.();
    await window.clearScribe?.saveSettings?.({
      ...(current || {}),
      localSpeechEngine: selectedTranscriptionEngine(),
    });
  } catch {
    // The renderer setting is still persisted locally.
  } finally {
    checkRuntime();
  }
}

function friendlyTranscriptionError(error, audioStats = null) {
  const message = String(error?.message || "");
  if (/decode|invalid data|opening input|opening output|ffmpeg/i.test(message)) {
    return "The recording could not be decoded. Please try again.";
  }
  if (/no speech|without transcript|no transcript/i.test(message)) {
    if (isQuietAudio(audioStats)) {
      return "I could not hear enough microphone input. Check the selected mic or speak closer.";
    }
    return "No speech was detected. Try speaking a little longer.";
  }
  if (/command not found|not found/i.test(message)) {
    return "Local Whisper is not available. Check Settings.";
  }
  return message || "No transcript was produced.";
}

function prepareTranscriptText(transcript) {
  const collapsed = collapseTranscriptLoops(transcript);
  const polished = polishPlainDictation(collapsed);
  return normalizeHistoryText(polished);
}

function hasMeaningfulSpeech(text) {
  const value = String(text || "")
    .replace(/[\s.,;:!?¿¡'"`´“”‘’()[\]{}<>/\\|_*~=-]+/g, "")
    .trim();
  const matches = value.match(/[\p{L}\p{N}]/gu) || [];
  return matches.length >= 2;
}

function transcriptPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function measureAudioChunks(chunks) {
  let samples = 0;
  let sumSquares = 0;
  let peak = 0;

  chunks.forEach((chunk) => {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Number(chunk[index]) || 0;
      const absolute = Math.abs(sample);
      peak = Math.max(peak, absolute);
      sumSquares += sample * sample;
      samples += 1;
    }
  });

  const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
  return {
    samples,
    rms: roundAudioLevel(rms),
    peak: roundAudioLevel(peak),
  };
}

function roundAudioLevel(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function isQuietAudio(audioStats) {
  if (!audioStats || !audioStats.samples) return false;
  return Number(audioStats.peak || 0) < 0.01 && Number(audioStats.rms || 0) < 0.002;
}

function collapseTranscriptLoops(text) {
  let tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 10) return normalizeSpacing(String(text || ""));

  for (let pass = 0; pass < 3; pass += 1) {
    const next = collapseAdjacentTokenRepeats(tokens);
    if (next.length === tokens.length) break;
    tokens = next;
  }

  return normalizeSpacing(tokens.join(" "));
}

function collapseAdjacentTokenRepeats(tokens) {
  const output = [];
  let index = 0;

  while (index < tokens.length) {
    const repeat = findRepeatAt(tokens, index);
    if (repeat) {
      output.push(...tokens.slice(index, index + repeat.length));
      index += repeat.length * repeat.count;
      continue;
    }
    output.push(tokens[index]);
    index += 1;
  }

  return output;
}

function findRepeatAt(tokens, start) {
  const maxLength = Math.min(14, Math.floor((tokens.length - start) / 2));
  for (let length = maxLength; length >= 2; length -= 1) {
    const key = phraseKey(tokens, start, length);
    if (!key) continue;

    let count = 1;
    while (start + length * (count + 1) <= tokens.length && phraseKey(tokens, start + length * count, length) === key) {
      count += 1;
    }

    if (count >= 3 || (count >= 2 && length >= 5)) {
      return { length, count };
    }
  }
  return null;
}

function phraseKey(tokens, start, length) {
  return tokens
    .slice(start, start + length)
    .map(tokenKey)
    .filter(Boolean)
    .join(" ");
}

function tokenKey(token) {
  return String(token || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeHistoryText(text) {
  return normalizeSpacing(collapseTranscriptLoops(text));
}

function cleanupAudioRecorder() {
  if (audioProcessor) {
    audioProcessor.onaudioprocess = null;
    try {
      audioProcessor.disconnect();
    } catch {
      // Already disconnected.
    }
    audioProcessor = null;
  }
  if (audioSource) {
    try {
      audioSource.disconnect();
    } catch {
      // Already disconnected.
    }
    audioSource = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  recordingMimeType = "";
  recordingMode = "";
  wavSampleRate = 0;
  window.clearTimeout(autoStopTimerId);
  autoStopTimerId = null;
  audioChunks = [];
  stopInProgress = false;
}

function encodeWav(chunks, sampleRate) {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  chunks.forEach((chunk) => {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  });

  return buffer;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function updateTimer(reset = false) {
  if (reset) {
    els.timer.textContent = "00:00";
    return;
  }
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mins = String(Math.floor(total / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  els.timer.textContent = `${mins}:${secs}`;
  publishOverlay({
    type: "recording",
    elapsed: els.timer.textContent,
    text: livePreviewText,
    detail: livePreviewText ? "Live transcript" : undefined,
  });
}

function startLivePreview() {
  stopLivePreview();
  if (!window.clearScribe?.previewTranscription) return;
  livePreviewSeq += 1;
  livePreviewText = "";
  const seq = livePreviewSeq;
  livePreviewTimerId = window.setInterval(() => requestLivePreview(seq), LIVE_PREVIEW_INTERVAL_MS);
  window.setTimeout(() => requestLivePreview(seq), LIVE_PREVIEW_MIN_MS);
  render({ persist: false });
}

function stopLivePreview(options = {}) {
  window.clearInterval(livePreviewTimerId);
  livePreviewTimerId = null;
  livePreviewSeq += 1;
  livePreviewInFlight = false;
  if (!options.keepText) livePreviewText = "";
  render({ persist: false });
}

async function requestLivePreview(seq = livePreviewSeq) {
  if (seq !== livePreviewSeq || livePreviewInFlight || stopInProgress || !isRecording()) return;
  const snapshot = buildLivePreviewSnapshot();
  if (!snapshot) return;

  livePreviewInFlight = true;
  try {
    const data = await window.clearScribe.previewTranscription({
      audioBuffer: snapshot.buffer,
      mimeType: "audio/wav",
      filename: `shadiflow-live-${Date.now()}.wav`,
      language: selectedWhisperLanguage(),
      engine: selectedTranscriptionEngine(),
      audioStats: snapshot.audioStats,
      preview: true,
    });
    if (seq !== livePreviewSeq || stopInProgress || !isRecording()) return;

    const transcript = String(data?.text || "").trim();
    if (!hasMeaningfulSpeech(transcript)) return;

    const text = prepareTranscriptText(transcript);
    if (!hasMeaningfulSpeech(text) || text === livePreviewText) return;

    livePreviewText = text;
    setFlow("Listening", text, { words: countWords(text) });
    render({ persist: false });
    publishOverlay({
      type: "recording",
      elapsed: els.timer.textContent,
      text,
      detail: "Live transcript",
    });
    logDesktopEvent("recording:live-preview", {
      ...activeRecording,
      textLength: text.length,
      transcriptPreview: transcriptPreview(text),
      durationMs: data?.durationMs || 0,
      audioDurationMs: snapshot.durationMs,
      engine: data?.engine || selectedTranscriptionEngine(),
    });
  } catch (error) {
    if (seq === livePreviewSeq) {
      logDesktopEvent("recording:live-preview-failed", {
        message: String(error?.message || error).slice(0, 500),
      });
    }
  } finally {
    if (seq === livePreviewSeq) livePreviewInFlight = false;
  }
}

function buildLivePreviewSnapshot() {
  if (recordingMode !== "wav" || !audioChunks.length) return null;
  const sampleRate = wavSampleRate || 48000;
  const totalSamples = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const durationMs = Math.round((totalSamples / sampleRate) * 1000);
  if (durationMs < LIVE_PREVIEW_MIN_MS) return null;

  const maxSamples = Math.round((sampleRate * LIVE_PREVIEW_MAX_MS) / 1000);
  const chunks = sliceAudioWindow(audioChunks, maxSamples);
  if (!chunks.length) return null;
  return {
    buffer: encodeWav(chunks, sampleRate),
    audioStats: measureAudioChunks(chunks),
    durationMs: Math.min(durationMs, LIVE_PREVIEW_MAX_MS),
  };
}

function sliceAudioWindow(chunks, maxSamples) {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const startSample = Math.max(0, totalSamples - maxSamples);
  const output = [];
  let cursor = 0;

  chunks.forEach((chunk) => {
    const chunkStart = cursor;
    const chunkEnd = cursor + chunk.length;
    cursor = chunkEnd;
    if (chunkEnd <= startSample) return;

    const from = Math.max(0, startSample - chunkStart);
    output.push(chunk.slice(from));
  });

  return output;
}

function setFlow(title, detail, options = {}) {
  els.flowState.textContent = title;
  els.flowLine.textContent = detail;
  const words = Number.isFinite(options.words) ? options.words : state.history[0]?.words || 0;
  els.wordCount.textContent = `${words} ${words === 1 ? "word" : "words"}`;
}

function publishOverlay(status) {
  if (activeRecording.autoInsert && window.clearScribe?.publishDictationStatus) {
    window.clearScribe.publishDictationStatus(status);
  }
}

function polishPlainDictation(input) {
  let text = ` ${input || ""} `;
  text = normalizeSpokenPunctuation(text);
  const dictionaryResult = applyDictionary(text);
  text = dictionaryResult.text;
  text = applySnippets(text);
  text = resolveCorrections(text);
  text = removeFillers(text);
  text = normalizeSpacing(text);
  return sentenceCase(text).replace(/\bi\b/g, "I");
}

function normalizeSpokenPunctuation(text) {
  return text
    .replace(/\bnew paragraph\b/gi, "\n\n")
    .replace(/\bnew line\b/gi, "\n")
    .replace(/\bcomma\b/gi, ",")
    .replace(/\bperiod\b/gi, ".")
    .replace(/\bfull stop\b/gi, ".")
    .replace(/\bquestion mark\b/gi, "?")
    .replace(/\bexclamation mark\b/gi, "!")
    .replace(/\bcolon\b/gi, ":")
    .replace(/\bsemicolon\b/gi, ";")
    .replace(/\bdot\b/gi, ".")
    .replace(/\bslash\b/gi, "/");
}

function applyDictionary(text) {
  let next = text;
  let fixes = 0;
  state.dictionary.forEach((word) => {
    (word.aliases || []).forEach((alias) => {
      if (!alias.trim()) return;
      const before = next;
      next = next.replace(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi"), word.term);
      if (next !== before) fixes += 1;
    });
  });
  return { text: next, fixes };
}

function applySnippets(text) {
  let next = text;
  state.snippets.forEach((snippet) => {
    if (!snippet.cue.trim()) return;
    next = next.replace(new RegExp(`\\b${escapeRegExp(snippet.cue)}\\b`, "gi"), ` ${snippet.body} `);
  });
  return next;
}

function resolveCorrections(text) {
  return text
    .replace(/\b(actually|sorry|rather|i mean)\s+(make that\s+)?/gi, "")
    .replace(/\bno,\s*/gi, "");
}

function removeFillers(text) {
  return text.replace(/\b(um+|uh+|erm+|ah+|hmm+|like|you know|kind of|sort of|basically|literally|honestly)\b[, ]*/gi, "");
}

function normalizeSpacing(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/([,.;:?!])([^\s\n])/g, "$1 $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sentenceCase(text) {
  return text.replace(/(^|[.!?]\s+|\n+)([a-z])/g, (match, lead, char) => `${lead}${char.toUpperCase()}`);
}

function applyTransform(input, transform) {
  const clean = polishPlainDictation(input);
  if (!transform) return clean;
  const name = transform.name.toLowerCase();
  if (name.includes("prompt")) return `Goal\n${clean}\n\nInstructions\nReturn a clear, structured answer with assumptions and next steps.`;
  if (name.includes("polish")) return clean.replace(/\bI wanna\b/gi, "I want to");
  return `${clean}\n\n${transform.prompt}`;
}

function createHistory(text, createdAt = Date.now(), app = "ShadiFlow", durationMs = 2500) {
  const words = countWords(text);
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return { id: uid(), text, createdAt, app, words, wpm: Math.max(1, Math.round((words / seconds) * 60)) };
}

function normalizeHistory(history) {
  return history
    .map((item) => ({
      ...item,
      text: normalizeHistoryText(item?.text || ""),
    }))
    .filter((item) => item && hasMeaningfulSpeech(item.text))
    .map((item) => ({
      ...item,
      words: countWords(item.text),
      wpm: item.wpm || 1,
    }));
}

function computeStats() {
  const totalWords = state.history.reduce((sum, item) => sum + (item.words || countWords(item.text)), 0);
  const wpm = Math.round(state.history.reduce((sum, item) => sum + (item.wpm || 0), 0) / Math.max(1, state.history.length));
  const fixes = state.dictionary.length * 11 + state.snippets.length * 3;
  return { totalWords, wpm, fixes, streak: streakDays() };
}

function streakDays() {
  const days = new Set(state.history.map((item) => new Date(item.createdAt).toDateString()));
  let streak = 0;
  const cursor = new Date();
  while (days.has(cursor.toDateString())) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return Math.max(streak, state.history.length ? 1 : 0);
}

function appUsage() {
  const counts = new Map();
  state.history.forEach((item) => counts.set(item.app, (counts.get(item.app) || 0) + item.words));
  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0) || 1;
  return Array.from(counts.entries()).map(([app, words]) => ({ app, percent: Math.round((words / total) * 100) })).sort((a, b) => b.percent - a.percent);
}

function groupHistory(items) {
  const groups = new Map();
  items.forEach((item) => {
    const label = dateLabel(item.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  return Array.from(groups.entries()).map(([label, groupItems]) => ({ label, items: groupItems }));
}

function filteredScoped(items, tab) {
  if (tab === "all") return items;
  return items.filter((item) => item.scope === tab);
}

function upsert(key, item) {
  const list = state[key];
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) list[index] = item;
  else list.unshift(item);
  persist();
  render();
}

function deleteItem(key, id) {
  state[key] = state[key].filter((item) => item.id !== id);
  persist();
  render();
}

function toggleScope(key, id) {
  const item = findById(state[key], id);
  if (!item) return;
  item.scope = item.scope === "team" ? "personal" : "team";
  persist();
  render();
}

function findById(items, id) {
  return items.find((item) => item.id === id);
}

async function copyValue(text) {
  if (!text) return;
  if (window.clearScribe?.copyText) await window.clearScribe.copyText(text);
  else await navigator.clipboard.writeText(text);
  notify("Copied");
}

function notify(message) {
  setFlow("Ready", message);
  window.setTimeout(() => setFlow("Ready", "Shortcut or mic to dictate anywhere"), 1800);
}

function value(selector) {
  return document.querySelector(selector)?.value.trim() || "";
}

function empty(title, body) {
  return `<div class="empty-state"><div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(body)}</p></div></div>`;
}

function settingTitle(value) {
  return escapeHTML(value);
}

function selected(value, current) {
  return value === current ? "selected" : "";
}

function dateLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function favoritePhrase() {
  return state.history[0]?.text || "Say it clearly, then keep moving.";
}

function topApp() {
  return appUsage()[0]?.app || "ShadiFlow";
}

function countWords(text) {
  return (String(text).trim().match(/\b[\w'-]+\b/g) || []).length;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char];
  });
}

function escapeAttr(value) {
  return escapeHTML(value).replace(/`/g, "&#96;");
}
