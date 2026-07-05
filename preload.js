const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clearScribe", {
  getStatus: () => ipcRenderer.invoke("runtime:status"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  transcribe: (payload) => ipcRenderer.invoke("audio:transcribe", payload),
  previewTranscription: (payload) => ipcRenderer.invoke("audio:preview", payload),
  startStreamingTranscription: (payload) => ipcRenderer.invoke("audio:stream-start", payload),
  pushStreamingAudio: (payload) => ipcRenderer.invoke("audio:stream-audio", payload),
  finishStreamingTranscription: (payload) => ipcRenderer.invoke("audio:stream-finish", payload),
  cancelStreamingTranscription: (payload) => ipcRenderer.invoke("audio:stream-cancel", payload),
  insertText: (text, options) => ipcRenderer.invoke("text:insert", text, options || {}),
  copyText: (text) => ipcRenderer.invoke("text:copy", text),
  hideOverlay: () => ipcRenderer.invoke("overlay:hide"),
  getAccessibilityStatus: (prompt) => ipcRenderer.invoke("permissions:accessibility", Boolean(prompt)),
  openAccessibilitySettings: () => ipcRenderer.invoke("permissions:open-accessibility-settings"),
  publishDictationStatus: (status) => ipcRenderer.send("dictation:status", status),
  stopRecording: () => ipcRenderer.invoke("recording:stop"),
  cancelRecording: () => ipcRenderer.invoke("recording:cancel"),
  openSettingsFolder: () => ipcRenderer.invoke("app:open-settings-folder"),
  logEvent: (event, detail) => ipcRenderer.send("app:log", event, detail || {}),
  onShortcutToggle: (callback) => {
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on("shortcut-toggle", handler);
    return () => ipcRenderer.removeListener("shortcut-toggle", handler);
  },
  onShortcutStop: (callback) => {
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on("shortcut-stop", handler);
    return () => ipcRenderer.removeListener("shortcut-stop", handler);
  },
  onShortcutCancel: (callback) => {
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on("shortcut-cancel", handler);
    return () => ipcRenderer.removeListener("shortcut-cancel", handler);
  },
  onOverlayUpdate: (callback) => {
    const handler = (_event, payload) => callback(payload || {});
    ipcRenderer.on("overlay:update", handler);
    return () => ipcRenderer.removeListener("overlay:update", handler);
  },
});
