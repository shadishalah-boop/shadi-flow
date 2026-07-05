const hud = document.querySelector(".hud");
const title = document.querySelector("#title");
const detail = document.querySelector("#detail");
const elapsed = document.querySelector("#elapsed");
const expandedTitle = document.querySelector("#expanded-title");
const expandedDetail = document.querySelector("#expanded-detail");
const transcript = document.querySelector("#transcript");
const liveTranscript = document.querySelector("#live-transcript");
const copyButton = document.querySelector("#copy-transcript");
const primaryButton = document.querySelector("#primary-action");
const closeButton = document.querySelector("#close-overlay");
const stopButton = document.querySelector("#stop-recording");

let currentText = "";
let currentState = "starting";
let permissionRequired = false;

function updateOverlay(payload = {}) {
  currentState = payload.state || "starting";
  currentText = String(payload.text || "").trim();
  permissionRequired = Boolean(payload.permissionRequired || currentState === "permission");

  hud.dataset.state = currentState;
  title.textContent = compactTitle(payload);
  detail.textContent = compactDetail(payload);
  elapsed.textContent = payload.elapsed || "";
  liveTranscript.textContent = currentState === "recording" || currentState === "transcribing" ? currentText : "";
  expandedTitle.textContent = expandedHeading(payload);
  expandedDetail.textContent = payload.detail || "";
  transcript.textContent = currentText || "The transcript was copied to your clipboard.";
  primaryButton.textContent = permissionRequired ? "Open Settings" : "Done";
  copyButton.textContent = "Copy text";
  stopButton.textContent = "Stop";
  stopButton.disabled = currentState !== "recording";
}

function compactTitle(payload) {
  if (currentState === "inserted") return "Inserted";
  if (currentState === "transcribing") return "Transcribing";
  if (currentState === "recording") return "Listening";
  return payload.title || "Ready";
}

function compactDetail(payload) {
  if (payload.detail) return payload.detail;
  if (currentState === "recording") return "Press shortcut again to stop";
  if (currentState === "transcribing") return "Whisper is working locally";
  if (currentState === "inserted") return "Text pasted into the active app";
  return "";
}

function expandedHeading(payload) {
  if (payload.title) return payload.title;
  return permissionRequired ? "Enable automatic paste" : "Could not paste";
}

copyButton.addEventListener("click", async () => {
  if (!currentText) return;
  await window.clearScribe?.copyText?.(currentText);
  copyButton.textContent = "Copied";
});

primaryButton.addEventListener("click", async () => {
  if (permissionRequired) {
    await window.clearScribe?.openAccessibilitySettings?.();
    await window.clearScribe?.getAccessibilityStatus?.(true);
    return;
  }
  window.clearScribe?.hideOverlay?.();
});

closeButton.addEventListener("click", async () => {
  if (currentState === "recording") {
    await window.clearScribe?.cancelRecording?.();
    return;
  }
  window.clearScribe?.hideOverlay?.();
});

stopButton.addEventListener("click", async () => {
  if (currentState !== "recording") return;
  stopButton.disabled = true;
  stopButton.textContent = "Stopping";
  await window.clearScribe?.stopRecording?.();
});

if (window.clearScribe?.onOverlayUpdate) {
  window.clearScribe.onOverlayUpdate(updateOverlay);
}
