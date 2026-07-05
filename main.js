const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, screen, shell, systemPreferences } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");

const DEFAULT_LOCAL_WHISPER_COMMAND = "whisper";
const DEFAULT_LOCAL_WHISPER_MODEL = "large-v3-turbo";
const DEFAULT_LOCAL_PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const DEFAULT_FLUID_AUDIO_MODEL_VERSION = "v3";
const DEFAULT_FLUID_AUDIO_STREAMING_VARIANT = "parakeet-unified-320ms";
const DEFAULT_SPEECH_ENGINE = "fluid-parakeet";
const FLUID_AUDIO_HELPER_NAME = "shadiflow-fluid-helper";
const GLOBAL_SHORTCUT = "CommandOrControl+Shift+Space";
const FALLBACK_SHORTCUTS = ["CommandOrControl+Option+Space"];
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const PARAKEET_SUPPORTED_LANGUAGES = new Set([
  "",
  "auto",
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "es",
  "sv",
  "ru",
  "uk",
]);
const IGNORED_TARGET_BUNDLES = new Set([
  "app.shadiflow.desktop",
  "app.clearscribe.desktop",
  "com.apple.UserNotificationCenter",
  "com.apple.notificationcenterui",
  "com.apple.controlcenter",
  "com.apple.systemuiserver",
  "com.apple.dock",
  "com.apple.loginwindow",
  "com.apple.WindowManager",
]);
const IGNORED_TARGET_NAMES = new Set([
  "ShadiFlow",
  "ClearScribe",
  "UserNotificationCenter",
  "NotificationCenter",
  "Notification Center",
  "Control Center",
  "SystemUIServer",
  "Dock",
  "loginwindow",
  "WindowManager",
]);
const execFileAsync = promisify(execFile);

let mainWindow = null;
let overlayWindow = null;
let overlayHideTimer = null;
let targetPollTimer = null;
let isQuitting = false;
let lastDictationTarget = null;
let recentPasteTarget = null;
let recentPasteTargetAt = 0;
let shortcutRegistered = false;
let activeShortcut = GLOBAL_SHORTCUT;
let dictationState = "idle";
let whisperWorker = null;
let whisperWorkerKey = "";
let whisperWorkerRequestId = 0;
let whisperWorkerRequests = new Map();
let whisperWorkerStderr = "";
let materializedWhisperWorkerPath = "";
let warmWhisperWorkerPromise = null;
let warmFallbackWhisperPromise = null;
let fluidAudioHelper = null;
let fluidAudioHelperKey = "";
let fluidAudioHelperRequestId = 0;
let fluidAudioHelperRequests = new Map();
let fluidAudioHelperStderr = "";
let warmFluidAudioHelperPromise = null;
let dockMenuReady = false;
const resolvedCommandCache = new Map();

function appLogPath() {
  return path.join(app.getPath("userData"), "shadiflow.log");
}

function errorDetails(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "Unknown error").slice(0, 1200),
    stack: String(error?.stack || "").split("\n").slice(0, 8).join("\n"),
  };
}

function logEvent(event, detail = {}) {
  try {
    fsSync.mkdirSync(app.getPath("userData"), { recursive: true });
    fsSync.appendFileSync(
      appLogPath(),
      `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`,
      "utf8",
    );
  } catch {
    // Logging must never become a second failure path.
  }
}

function ensureDockPresence() {
  if (process.platform !== "darwin" || !app.dock) return;
  try {
    if (typeof app.setActivationPolicy === "function") {
      app.setActivationPolicy("regular");
    }
    const dockShow = app.dock.show();
    if (dockShow && typeof dockShow.catch === "function") {
      dockShow.catch((error) => {
        logEvent("dock:show-failed", errorDetails(error));
      });
    }
    if (!dockMenuReady) {
      app.dock.setMenu(Menu.buildFromTemplate([
        {
          label: "Open ShadiFlow",
          click: () => {
            presentMainWindow("dock-menu");
          },
        },
        {
          label: "Start Dictation",
          click: () => {
            handleGlobalDictationShortcut().catch((error) => {
              logEvent("dock:start-dictation-failed", errorDetails(error));
            });
          },
        },
        { type: "separator" },
        {
          label: "Quit ShadiFlow",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]));
      dockMenuReady = true;
    }
  } catch (error) {
    logEvent("dock:ensure-failed", errorDetails(error));
  }
}

function presentMainWindow(source = "manual") {
  ensureDockPresence();
  const win = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : createWindow({ show: false });
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === "darwin" && typeof app.focus === "function") {
    app.focus({ steal: true });
  }
  win.focus();
  logEvent("main-window:present", { source });
  return win;
}

process.on("uncaughtException", (error) => {
  logEvent("main:uncaughtException", errorDetails(error));
});

process.on("unhandledRejection", (reason) => {
  logEvent("main:unhandledRejection", errorDetails(reason));
});

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  logEvent("app:second-instance-exit");
  app.quit();
}

app.on("second-instance", (_event, commandLine = []) => {
  const selfTestArg = commandLine.find((arg) => String(arg).startsWith("--shadiflow-test-insert="));
  if (selfTestArg) {
    const encodedText = String(selfTestArg).slice("--shadiflow-test-insert=".length);
    const text = decodeURIComponent(encodedText || "ShadiFlow self test");
    const targetPidArg = commandLine.find((arg) => String(arg).startsWith("--shadiflow-test-target-pid="));
    const targetPid = targetPidArg
      ? Number(String(targetPidArg).slice("--shadiflow-test-target-pid=".length))
      : 0;
    const targetOverride = targetPid > 0
      ? {
          bundle: "",
          name: "Self test target",
          pid: targetPid,
          method: "self-test-arg",
        }
      : null;
    logEvent("app:second-instance-self-test", { textLength: text.length, target: describePasteTarget(targetOverride) });
    setTimeout(() => {
      runInsertSelfTest(text, targetOverride).catch((error) => {
        logEvent("self-test:insert-failed", errorDetails(error));
      });
    }, 250);
    return;
  }

  logEvent("app:second-instance-focus");
  ensureMainWindow(true);
});

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readSettings() {
  try {
    const data = await fs.readFile(settingsPath(), "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeSettings(nextSettings) {
  const current = await readSettings();
  const merged = { ...current, ...nextSettings };
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(merged, null, 2));
  return merged;
}

async function migrateFluidAudioSettings() {
  const settings = await readSettings();
  if (settings.fluidAudioMigrationV1) return settings;

  const currentEngine = normalizeSpeechEngine(settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE);
  if (currentEngine === "mlx-parakeet" || !settings.localSpeechEngine) {
    logEvent("settings:migrate-fluid-audio", { from: currentEngine, to: "fluid-parakeet" });
    return await writeSettings({
      localSpeechEngine: "fluid-parakeet",
      transcriptionEngine: "fluid-parakeet",
      fluidAudioMigrationV1: true,
      localFluidAudioModelVersion: settings.localFluidAudioModelVersion || DEFAULT_FLUID_AUDIO_MODEL_VERSION,
    });
  }

  return await writeSettings({ fluidAudioMigrationV1: true });
}

async function getRuntimeStatus() {
  const settings = await readSettings();
  const localWhisperCommand = settings.localWhisperCommand || DEFAULT_LOCAL_WHISPER_COMMAND;
  const speechEngine = normalizeSpeechEngine(settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE);
  const localWhisperModel = settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL;
  const localParakeetModel = settings.localParakeetModel || DEFAULT_LOCAL_PARAKEET_MODEL;
  const localFluidAudioReady = Boolean(await resolveFluidAudioHelperPath());
  const localWhisperEngine = speechEngine === "fluid-parakeet"
    ? "fluid-parakeet"
    : speechEngine === "mlx-parakeet"
    ? "mlx-parakeet"
    : speechEngine === "mlx-whisper"
      ? "mlx-whisper"
      : (await preferredWhisperEngine()) || "openai-whisper";
  const localParakeetReady = localFluidAudioReady || Boolean(await resolveMlxParakeetCommand());
  const localWhisperReady = speechEngine === "fluid-parakeet"
    ? localFluidAudioReady
    : speechEngine === "mlx-parakeet"
    ? localParakeetReady
    : speechEngine === "mlx-whisper"
      ? Boolean(await resolveMlxWhisperCommand())
      : Boolean(await commandExists(localWhisperCommand));
  return {
    appMode: "desktop",
    transcriptionProvider: "local-asr",
    localSpeechEngine: speechEngine,
    localWhisperCommand,
    localWhisperModel,
    localParakeetModel,
    localFluidAudioStreamingVariant: settings.localFluidAudioStreamingVariant || DEFAULT_FLUID_AUDIO_STREAMING_VARIANT,
    localActiveModel: speechEngine === "fluid-parakeet"
      ? "FluidAudio Parakeet TDT v3"
      : speechEngine === "mlx-parakeet"
        ? localParakeetModel
        : localWhisperModel,
    localWhisperReady,
    localParakeetReady,
    localFluidAudioReady,
    localWhisperEngine,
    localWhisperWarm: Boolean(
      (whisperWorker && !whisperWorker.killed && whisperWorker.exitCode === null) ||
      (fluidAudioHelper && !fluidAudioHelper.killed && fluidAudioHelper.exitCode === null)
    ),
    shortcut: activeShortcut,
    primaryShortcut: GLOBAL_SHORTCUT,
    shortcutRegistered,
  };
}

function createWindow(options = {}) {
  ensureDockPresence();
  const shouldShow = options.show !== false;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: shouldShow,
    title: "ShadiFlow",
    backgroundColor: "#f6f7f4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  const win = mainWindow;

  win.on("show", () => logEvent("main-window:show"));
  win.on("hide", () => {
    logEvent("main-window:hide");
    ensureDockPresence();
  });
  win.on("unresponsive", () => logEvent("main-window:unresponsive"));
  win.on("responsive", () => logEvent("main-window:responsive"));

  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    logEvent("main-window:close-hidden", { dictationState });
    if (dictationState === "recording") {
      sendRecordingCancelCommand("window-close");
      dictationState = "idle";
      hideOverlayAfter(250);
    }
    win.hide();
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logEvent("main-window:render-process-gone", details);
    if (mainWindow === win) mainWindow = null;
    if (!win.isDestroyed()) win.destroy();
    if (!isQuitting) {
      setTimeout(() => createWindow({ show: false }), 250);
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logEvent("main-window:did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

function registerShortcut() {
  shortcutRegistered = false;
  activeShortcut = GLOBAL_SHORTCUT;

  for (const shortcut of [GLOBAL_SHORTCUT, ...FALLBACK_SHORTCUTS]) {
    const registered = globalShortcut.register(shortcut, handleGlobalDictationShortcut);
    logEvent("shortcut:register-attempt", { shortcut, registered });
    if (registered) {
      activeShortcut = shortcut;
      shortcutRegistered = true;
      break;
    }
  }

  if (!shortcutRegistered) {
    logEvent("shortcut:register-failed", { shortcuts: [GLOBAL_SHORTCUT, ...FALLBACK_SHORTCUTS] });
    showOverlay({
      state: "error",
      title: "Shortcut unavailable",
      detail: "Another app is using the dictation shortcut. Quit it or reopen ShadiFlow.",
      shortcut: shortcutLabel(),
    });
    hideOverlayAfter(7000);
  }
}

async function handleGlobalDictationShortcut() {
  if (dictationState === "recording") {
    sendRecordingStopCommand("global");
    showOverlay({
      state: "transcribing",
      title: "Stopping",
      detail: "Finishing recording",
      shortcut: shortcutLabel(),
    });
    return;
  }

  if (dictationState === "transcribing") {
    showOverlay({
      state: "transcribing",
      title: "Transcribing",
      detail: "Still working on the last recording",
      shortcut: shortcutLabel(),
    });
    return;
  }

  lastDictationTarget = await refreshPasteTarget("shortcut") || recentPasteTarget;
  logEvent("dictation:target-selected", {
    target: describePasteTarget(lastDictationTarget),
    targetAgeMs: recentPasteTargetAt ? Date.now() - recentPasteTargetAt : null,
  });
  if (!lastDictationTarget) {
    showOverlay({
      state: "error",
      title: "Select a text field",
      detail: "Click where you want text inserted, then press the shortcut again.",
      shortcut: shortcutLabel(),
    });
    hideOverlayAfter(4200);
    return;
  }
  if (!hasAccessibilityPermission(false)) {
    hasAccessibilityPermission(true);
  }
  showOverlay({
    state: "starting",
    title: "Getting mic ready",
    detail: `${shortcutLabel()} again to stop`,
    shortcut: shortcutLabel(),
  });
  const windowForRecording = ensureMainWindow(false);
  sendToWindowWhenReady(windowForRecording, "shortcut-toggle", {
    source: "global",
    autoInsert: true,
    shortcut: activeShortcut,
  });
  dictationState = "recording";
}

async function captureFrontmostApp(source = "manual") {
  if (process.platform !== "darwin") return null;
  const candidates = [];

  const nsWorkspaceTarget = await captureFrontmostWithNSWorkspace(source);
  if (nsWorkspaceTarget) candidates.push(nsWorkspaceTarget);

  const systemEventsTarget = await captureFrontmostWithSystemEvents(source);
  if (systemEventsTarget) candidates.push(systemEventsTarget);

  const target = candidates.find(isUsablePasteTarget) || null;
  if (!target && source !== "poll") {
    logEvent("paste:capture-no-usable-target", {
      source,
      candidates: candidates.map(describePasteTarget),
    });
  }
  return target;
}

async function captureFrontmostWithNSWorkspace(source = "manual") {
  try {
    const script = [
      'ObjC.import("AppKit");',
      "const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
      'const bundle = app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : "";',
      'const name = app.localizedName ? ObjC.unwrap(app.localizedName) : "";',
      "const pid = Number(app.processIdentifier);",
      "console.log(JSON.stringify({ bundle, name, pid }));",
    ].join(" ");
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 2500,
      maxBuffer: 256 * 1024,
    });
    const target = JSON.parse(stdout.trim() || "{}");
    return normalizePasteTarget(target, "nsworkspace");
  } catch (error) {
    if (source !== "poll") logEvent("paste:capture-nsworkspace-failed", { ...errorDetails(error), source });
    return null;
  }
}

async function captureFrontmostWithSystemEvents(source = "manual") {
  if (!hasAccessibilityPermission(false)) return null;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application "System Events"',
        "-e",
        "set p to first application process whose frontmost is true",
        "-e",
        'set bid to ""',
        "-e",
        "try",
        "-e",
        "set bid to bundle identifier of p",
        "-e",
        "end try",
        "-e",
        'return (name of p) & linefeed & bid & linefeed & ((unix id of p) as text)',
        "-e",
        "end tell",
      ],
      { timeout: 1800, maxBuffer: 64 * 1024 },
    );
    const [name = "", bundle = "", pid = "0"] = stdout.trim().split(/\r?\n/);
    return normalizePasteTarget({ name, bundle, pid: Number(pid) }, "system-events");
  } catch (error) {
    if (source !== "poll") logEvent("paste:capture-system-events-failed", { ...errorDetails(error), source });
    return null;
  }
}

function normalizePasteTarget(target, method = "") {
  const normalized = {
    bundle: String(target?.bundle || "").trim(),
    name: String(target?.name || "").trim(),
    pid: Number(target?.pid) || 0,
    method,
  };
  if (!normalized.bundle && !normalized.name) return null;
  return normalized;
}

function isUsablePasteTarget(target) {
  if (!target) return false;
  if (target.bundle && IGNORED_TARGET_BUNDLES.has(target.bundle)) return false;
  if (target.name && IGNORED_TARGET_NAMES.has(target.name)) return false;
  if (target.pid && target.pid === process.pid) return false;
  return Boolean(target.bundle || target.name);
}

async function refreshPasteTarget(source = "poll") {
  const target = await captureFrontmostApp(source);
  if (!target) return null;
  const previousTarget = describePasteTarget(recentPasteTarget);
  recentPasteTarget = target;
  recentPasteTargetAt = Date.now();
  const nextTarget = describePasteTarget(target);
  const changed = !previousTarget ||
    previousTarget.pid !== nextTarget.pid ||
    previousTarget.bundle !== nextTarget.bundle ||
    previousTarget.name !== nextTarget.name;
  if (source !== "poll" || changed) {
    logEvent(source === "poll" ? "paste:target-updated" : "paste:target-refreshed", {
      source,
      target: nextTarget,
    });
  }
  return target;
}

function startPasteTargetPolling() {
  clearInterval(targetPollTimer);
  targetPollTimer = setInterval(() => {
    if (dictationState !== "idle") return;
    refreshPasteTarget("poll").catch((error) => {
      logEvent("paste:target-poll-failed", errorDetails(error));
    });
  }, 1000);
}

function describePasteTarget(target) {
  if (!target) return null;
  return {
    bundle: target.bundle || "",
    name: target.name || "",
    pid: Number(target.pid) || 0,
    method: target.method || "",
  };
}

function ensureMainWindow(show = true) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    const win = createWindow({ show: false });
    return show ? presentMainWindow("ensure") : win;
  }
  if (show) return presentMainWindow("ensure");
  return mainWindow;
}

function sendToWindowWhenReady(browserWindow, channel, payload) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const send = () => {
    if (!browserWindow.isDestroyed()) browserWindow.webContents.send(channel, payload);
  };
  if (browserWindow.webContents.isLoading()) {
    browserWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function dispatchWindowEventWhenReady(browserWindow, eventName, detail) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${JSON.stringify(detail)} }));`;
  const send = () => {
    if (browserWindow.isDestroyed()) return;
    browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
  };
  if (browserWindow.webContents.isLoading()) {
    browserWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function sendRecordingStopCommand(source = "global") {
  const windowForRecording = ensureMainWindow(false);
  const payload = {
    source,
    shortcut: activeShortcut,
    issuedAt: Date.now(),
  };
  const send = () => {
    sendToWindowWhenReady(windowForRecording, "shortcut-stop", payload);
    dispatchWindowEventWhenReady(windowForRecording, "shadiflow-stop-recording", payload);
  };

  send();
  setTimeout(() => {
    if (dictationState === "recording") send();
  }, 150);
  setTimeout(() => {
    if (dictationState === "recording") send();
  }, 500);

  return windowForRecording;
}

function sendRecordingCancelCommand(source = "global") {
  const windowForRecording = ensureMainWindow(false);
  const payload = {
    source,
    shortcut: activeShortcut,
    issuedAt: Date.now(),
  };
  const send = () => {
    sendToWindowWhenReady(windowForRecording, "shortcut-cancel", payload);
    dispatchWindowEventWhenReady(windowForRecording, "shadiflow-cancel-recording", payload);
  };

  send();
  setTimeout(() => send(), 150);
  setTimeout(() => send(), 500);

  return windowForRecording;
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  overlayWindow = new BrowserWindow({
    width: 170,
    height: 58,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
  overlayWindow.webContents.on("render-process-gone", (_event, details) => {
    logEvent("overlay:render-process-gone", details);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    overlayWindow = null;
  });
  return overlayWindow;
}

function showOverlay(payload) {
  const win = ensureOverlayWindow();
  resizeOverlay(win, payload);
  positionOverlay(win);
  clearTimeout(overlayHideTimer);

  const update = () => {
    if (win.isDestroyed()) return;
    win.webContents.send("overlay:update", payload);
    win.showInactive();
  };

  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", update);
  } else {
    update();
  }
}

function resizeOverlay(win, payload = {}) {
  const state = payload.state;
  const hasLiveText = (state === "recording" || state === "transcribing") && String(payload.text || "").trim();
  const expanded = state === "permission" || state === "error";
  const inserted = state === "inserted";
  const size = expanded
    ? { width: 560, height: 220 }
    : inserted
      ? { width: 420, height: 84 }
      : hasLiveText
        ? { width: 620, height: 166 }
        : { width: 360, height: 76 };
  const [currentWidth, currentHeight] = win.getSize();
  if (currentWidth !== size.width || currentHeight !== size.height) {
    win.setSize(size.width, size.height, false);
  }
}

function hideOverlayAfter(delayMs = 1300) {
  clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  }, delayMs);
}

function positionOverlay(win) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea;
  const [width, height] = win.getSize();
  win.setBounds({
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + 14),
    width,
    height,
  });
}

function shortcutLabel(shortcut = activeShortcut) {
  const commandKey = process.platform === "darwin" ? "Cmd" : "Ctrl";
  const optionKey = process.platform === "darwin" ? "Option" : "Alt";
  return String(shortcut || GLOBAL_SHORTCUT)
    .replace("CommandOrControl", commandKey)
    .replace("Option", optionKey);
}

ipcMain.handle("settings:get", async () => {
  const settings = await readSettings();
  const speechEngine = normalizeSpeechEngine(settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE);
  return {
    localSpeechEngine: speechEngine,
    localWhisperCommand: settings.localWhisperCommand || DEFAULT_LOCAL_WHISPER_COMMAND,
    localWhisperModel: settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL,
    localParakeetModel: settings.localParakeetModel || DEFAULT_LOCAL_PARAKEET_MODEL,
    localFluidAudioModelVersion: settings.localFluidAudioModelVersion || DEFAULT_FLUID_AUDIO_MODEL_VERSION,
    localFluidAudioStreamingVariant: settings.localFluidAudioStreamingVariant || DEFAULT_FLUID_AUDIO_STREAMING_VARIANT,
    localWhisperEngine: speechEngine === "fluid-parakeet"
      ? "fluid-parakeet"
      : speechEngine === "mlx-parakeet"
      ? "mlx-parakeet"
      : speechEngine === "mlx-whisper"
        ? "mlx-whisper"
        : (await preferredWhisperEngine()) || "openai-whisper",
    localWhisperModelPath: settings.localWhisperModelPath || "",
    localWhisperArgs: settings.localWhisperArgs || "",
  };
});

ipcMain.handle("settings:save", async (_event, settings) => {
  const saved = await writeSettings({
    localSpeechEngine: normalizeSpeechEngine(settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE),
    localWhisperCommand: String(settings.localWhisperCommand || DEFAULT_LOCAL_WHISPER_COMMAND).trim(),
    localWhisperModel: String(settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL).trim(),
    localParakeetModel: String(settings.localParakeetModel || DEFAULT_LOCAL_PARAKEET_MODEL).trim(),
    localFluidAudioModelVersion: String(settings.localFluidAudioModelVersion || DEFAULT_FLUID_AUDIO_MODEL_VERSION).trim(),
    localFluidAudioStreamingVariant: String(settings.localFluidAudioStreamingVariant || DEFAULT_FLUID_AUDIO_STREAMING_VARIANT).trim(),
    localWhisperModelPath: String(settings.localWhisperModelPath || "").trim(),
    localWhisperArgs: String(settings.localWhisperArgs || "").trim(),
  });
  setTimeout(() => warmWhisperWorkerInBackground(), 100);
  return saved;
});

ipcMain.handle("runtime:status", getRuntimeStatus);

ipcMain.on("app:log", (_event, event, detail = {}) => {
  logEvent(`renderer:${String(event || "event").slice(0, 80)}`, detail);
});

ipcMain.handle("audio:transcribe", async (_event, payload) => {
  const settings = await readSettings();
  return transcribeWithLocalWhisper(payload, settings);
});

ipcMain.handle("audio:preview", async (_event, payload) => {
  const settings = await readSettings();
  return transcribeWithLocalWhisper({ ...payload, preview: true }, settings, { preview: true });
});

ipcMain.handle("audio:stream-start", async (_event, payload = {}) => {
  const settings = await readSettings();
  const helperPath = await resolveFluidAudioHelperPath();
  if (!helperPath) throw new Error("FluidAudio helper is not available.");

  const sessionId = String(payload.sessionId || `stream-${Date.now()}`).trim();
  const variant = fluidAudioStreamingVariant(payload.variant || settings.localFluidAudioStreamingVariant);
  const started = Date.now();
  const result = await callFluidAudioHelper(helperPath, {
    op: "stream_start",
    sessionId,
    variant,
    language: payload.language || "",
  });
  logEvent("audio:stream-start-result", {
    sessionId,
    variant: result.variant || variant,
    model: result.model || "",
    durationMs: Date.now() - started,
    workerDurationMs: Number(result.workerDurationMs || 0),
  });
  return result;
});

ipcMain.handle("audio:stream-audio", async (_event, payload = {}) => {
  const helperPath = await resolveFluidAudioHelperPath();
  if (!helperPath) throw new Error("FluidAudio helper is not available.");

  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("Missing streaming session id.");
  const pcmBuffer = Buffer.from(payload.pcmBuffer || []);
  if (!pcmBuffer.length) return { ok: true, text: "", partial: true };
  if (pcmBuffer.length > 2 * 1024 * 1024) throw new Error("Streaming audio chunk is too large.");

  const started = Date.now();
  const result = await callFluidAudioHelper(helperPath, {
    op: "stream_audio",
    sessionId,
    pcmBase64: pcmBuffer.toString("base64"),
    sampleRate: Number(payload.sampleRate || 48000),
    channels: Number(payload.channels || 1),
  });
  logEvent("audio:stream-audio-result", {
    sessionId,
    textLength: String(result.text || "").length,
    textPreview: transcriptPreview(result.text || ""),
    durationMs: Date.now() - started,
    workerDurationMs: Number(result.workerDurationMs || 0),
    audioDurationMs: Number(result.audioDurationMs || 0),
  });
  return result;
});

ipcMain.handle("audio:stream-finish", async (_event, payload = {}) => {
  const helperPath = await resolveFluidAudioHelperPath();
  if (!helperPath) throw new Error("FluidAudio helper is not available.");

  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("Missing streaming session id.");
  const started = Date.now();
  const result = await callFluidAudioHelper(helperPath, {
    op: "stream_finish",
    sessionId,
  });
  logEvent("audio:stream-finish-result", {
    sessionId,
    textLength: String(result.text || "").length,
    textPreview: transcriptPreview(result.text || ""),
    durationMs: Date.now() - started,
    workerDurationMs: Number(result.workerDurationMs || 0),
    audioDurationMs: Number(result.audioDurationMs || 0),
    variant: result.variant || "",
  });
  return result;
});

ipcMain.handle("audio:stream-cancel", async (_event, payload = {}) => {
  const helperPath = await resolveFluidAudioHelperPath();
  if (!helperPath) return { ok: true };

  const sessionId = String(payload.sessionId || "").trim();
  const result = await callFluidAudioHelper(helperPath, {
    op: "stream_cancel",
    sessionId,
  });
  logEvent("audio:stream-cancel-result", { sessionId, ok: Boolean(result.ok) });
  return result;
});

ipcMain.handle("recording:stop", async () => {
  sendRecordingStopCommand("overlay");
  showOverlay({
    state: "transcribing",
    title: "Stopping",
    detail: "Finishing recording",
    shortcut: shortcutLabel(),
  });
  return { ok: true };
});

ipcMain.handle("recording:cancel", async () => {
  sendRecordingCancelCommand("overlay");
  dictationState = "idle";
  hideOverlayAfter(250);
  return { ok: true };
});

ipcMain.on("dictation:status", (_event, status) => {
  const next = status || {};
  if (next.type === "recording") {
    dictationState = "recording";
    showOverlay({
      state: "recording",
      title: "Recording",
      detail: next.detail || `${shortcutLabel()} again to stop`,
      text: next.text || "",
      elapsed: next.elapsed || "00:00",
      shortcut: shortcutLabel(),
    });
    return;
  }

  if (next.type === "transcribing") {
    dictationState = "transcribing";
    showOverlay({
      state: "transcribing",
      title: "Transcribing",
      detail: "Whisper is turning speech into text",
      text: next.text || "",
      elapsed: next.elapsed || "",
      shortcut: shortcutLabel(),
    });
    return;
  }

  if (next.type === "inserted") {
    dictationState = "idle";
    showOverlay({
      state: "inserted",
      title: "Inserted",
      detail: next.detail || "Text pasted into the active app",
      text: next.text || "",
      elapsed: "",
      shortcut: shortcutLabel(),
    });
    hideOverlayAfter(1300);
    return;
  }

  if (next.type === "error") {
    dictationState = "idle";
    const needsPermission = Boolean(next.permissionRequired);
    showOverlay({
      state: needsPermission ? "permission" : "error",
      title: next.title || (needsPermission ? "Enable automatic paste" : "Dictation stopped"),
      detail: next.detail || "No text was inserted",
      text: next.text || "",
      permissionRequired: needsPermission,
      elapsed: "",
      shortcut: shortcutLabel(),
    });
    hideOverlayAfter(next.text ? 12000 : 3600);
    return;
  }

  if (next.type === "idle") {
    dictationState = "idle";
    hideOverlayAfter(900);
  }
});

async function transcribeWithLocalWhisper(payload, settings, options = {}) {
  const isPreview = Boolean(options.preview || payload.preview);
  const audioBuffer = Buffer.from(payload.audioBuffer);
  if (!audioBuffer.length) throw new Error("No audio received.");
  if (audioBuffer.length > MAX_AUDIO_BYTES) throw new Error("Audio is larger than 25 MB.");
  const inputExtension = audioExtensionForPayload(payload);
  const audioStats = normalizeAudioStats(payload.audioStats);

  const requestedSpeechEngine = normalizeSpeechEngine(
    payload.engine || settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE,
  );
  let speechEngine = requestedSpeechEngine;
  if ((speechEngine === "fluid-parakeet" || speechEngine === "mlx-parakeet") && !parakeetSupportsLanguage(payload.language || "")) {
    logEvent("audio:parakeet-language-fallback", {
      engine: speechEngine,
      language: payload.language || "auto",
      fallbackEngine: "mlx-whisper",
    });
    speechEngine = "mlx-whisper";
  }
  let command = "";
  let fluidAudioHelperPath = "";
  if (speechEngine === "fluid-parakeet") {
    fluidAudioHelperPath = await resolveFluidAudioHelperPath();
    if (!fluidAudioHelperPath) {
      throw new Error(
        "FluidAudio helper is not available. Run npm run build:fluid and package the app again.",
      );
    }
  } else if (speechEngine === "mlx-whisper") {
    command = await resolveMlxWhisperCommand();
    if (!command) {
      throw new Error(
        "MLX Whisper runtime is not available. Install mlx-whisper in ShadiFlow's MLX runtime.",
      );
    }
  } else if (speechEngine === "mlx-parakeet") {
    command = await resolveMlxParakeetCommand();
    if (!command) {
      throw new Error(
        "MLX Parakeet runtime is not available. Install parakeet-mlx in ShadiFlow's MLX runtime.",
      );
    }
  } else {
    command = await resolveCommand(
      settings.localWhisperCommand || DEFAULT_LOCAL_WHISPER_COMMAND,
    );
  }
  if (speechEngine !== "fluid-parakeet" && !command) {
    throw new Error(
      `Local Whisper command not found: ${settings.localWhisperCommand || DEFAULT_LOCAL_WHISPER_COMMAND}`,
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shadiflow-"));
  const inputPath = path.join(tempDir, `dictation${inputExtension}`);
  const wavPath = path.join(tempDir, "dictation-normalized.wav");
  const outBase = path.join(tempDir, "transcript");
  await fs.writeFile(inputPath, audioBuffer);

  let audioPath = inputPath;
  let audioPrepDurationMs = 0;
  let audioDurationMs = inputExtension === ".wav" ? estimatePcmWavDurationMsFromBuffer(audioBuffer) : 0;
  const needsNormalization = !isPreview && shouldNormalizeAudio(audioStats);
  const canUseRawWav = inputExtension === ".wav" && (isPreview || !needsNormalization);
  const ffmpegCommand = await resolveCommand("ffmpeg");
  if (canUseRawWav) {
    logEvent("audio:prepare-result", {
      engine: speechEngine,
      preview: isPreview,
      mode: "raw-wav",
      inputBytes: audioBuffer.length,
      outputBytes: audioBuffer.length,
      audioDurationMs,
      audioPrepDurationMs,
      normalized: false,
    });
  } else if (ffmpegCommand) {
    try {
      const prepStarted = Date.now();
      const filter = needsNormalization
        ? "highpass=f=80,lowpass=f=8000,loudnorm=I=-18:LRA=11:TP=-1.5"
        : "highpass=f=80,lowpass=f=8000";
      await execFileAsync(
        ffmpegCommand,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inputPath,
          "-vn",
          "-acodec",
          "pcm_s16le",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-af",
          filter,
          wavPath,
        ],
        { env: pathSearchEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      );
      audioPrepDurationMs = Date.now() - prepStarted;
      const wavStats = await fs.stat(wavPath);
      if (!wavStats.size) throw new Error("ffmpeg produced an empty WAV file.");
      audioPath = wavPath;
      audioDurationMs = estimatePcmWavDurationMs(wavStats.size, 16000, 1, 16);
      logEvent("audio:prepare-result", {
        engine: speechEngine,
        preview: isPreview,
        mode: "ffmpeg",
        filter,
        inputBytes: audioBuffer.length,
        outputBytes: wavStats.size,
        audioDurationMs,
        audioPrepDurationMs,
        normalized: needsNormalization,
      });
    } catch (error) {
      throw new Error(
        `Could not decode the recording. ${summarizeToolOutput(error.stderr || error.message)}`,
      );
    }
  }

  const started = Date.now();
  try {
    const whisperOptions = {
      command,
      fluidAudioHelperPath,
      engine: speechEngine,
      audioPath,
      outputDir: tempDir,
      outputBase: outBase,
      language: payload.language || "",
      model: speechEngine === "fluid-parakeet"
        ? settings.localFluidAudioModelVersion || DEFAULT_FLUID_AUDIO_MODEL_VERSION
        : speechEngine === "mlx-parakeet"
        ? settings.localParakeetModel || DEFAULT_LOCAL_PARAKEET_MODEL
        : settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL,
      modelPath: settings.localWhisperModelPath || "",
      template: settings.localWhisperArgs || "",
    };
    let result = speechEngine === "fluid-parakeet"
      ? await runFluidAudioTranscription(whisperOptions)
      : await runWhisperTranscription(whisperOptions, tempDir);

    if (!isPreview && speechEngine !== "mlx-parakeet" && speechEngine !== "fluid-parakeet" && whisperOptions.language && shouldRetryWithAutoLanguage(result.text, audioDurationMs)) {
      logEvent("audio:retry-auto-language", {
        engine: speechEngine,
        model: result.model || whisperOptions.model,
        language: whisperOptions.language,
        audioDurationMs,
        textLength: result.text.length,
        textPreview: transcriptPreview(result.text),
      });
      result = {
        ...(await runWhisperTranscription({ ...whisperOptions, language: "" }, tempDir)),
        languageFallback: true,
      };
    }

    if (!isPreview && (speechEngine === "mlx-parakeet" || speechEngine === "fluid-parakeet") && !hasMeaningfulTranscript(result.text)) {
      const fallbackCommand = await resolveMlxWhisperCommand();
      if (fallbackCommand) {
        logEvent("audio:parakeet-empty-fallback", {
          engine: speechEngine,
          model: result.model || whisperOptions.model,
          audioDurationMs,
          textLength: result.text.length,
          textPreview: transcriptPreview(result.text),
        });
        result = {
          ...(await runWhisperTranscription({
            ...whisperOptions,
            command: fallbackCommand,
            engine: "mlx-whisper",
            model: settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL,
          }, tempDir)),
          asrFallback: true,
        };
      }
    }

    if (!result.text && !isPreview) throw new Error("Local transcription finished without transcript text.");
    return {
      text: result.text,
      model: result.model || settings.localWhisperModelPath || settings.localWhisperModel || "local-asr",
      engine: result.engine || speechEngine,
      workerDurationMs: result.workerDurationMs || 0,
      audioPrepDurationMs,
      durationMs: Date.now() - started,
      audioDurationMs,
      languageFallback: Boolean(result.languageFallback),
      asrFallback: Boolean(result.asrFallback),
      preview: isPreview,
    };
  } finally {
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runWhisperTranscription(options, tempDir) {
  let text = "";
  let resolvedModel = options.model;
  let workerDurationMs = 0;

  if (canUseWarmWhisperWorker(options)) {
    try {
      const result = await callWhisperWorker(options.command, {
        op: "transcribe",
        audioPath: options.audioPath,
        language: options.language,
        model: options.model,
        engine: workerEngineForSpeechEngine(options.engine),
      });
      text = String(result.text || "").trim();
      workerDurationMs = Number(result.workerDurationMs || 0);
      resolvedModel = result.model || resolvedModel;
      logEvent("audio:worker-result", {
        engine: options.engine,
        model: resolvedModel,
        language: options.language || "auto",
        textLength: text.length,
        textPreview: transcriptPreview(text),
        meaningful: hasMeaningfulTranscript(text),
        workerDurationMs,
      });
    } catch (error) {
      stopWhisperWorker();
      if (options.engine === "openai-whisper" || options.engine === "whisper-cli") {
        text = await transcribeWithWhisperCli(options, tempDir);
      } else {
        throw error;
      }
    }
  } else {
    text = await transcribeWithWhisperCli(options, tempDir);
  }

  return {
    text,
    model: resolvedModel,
    engine: options.engine,
    workerDurationMs,
  };
}

async function runFluidAudioTranscription(options) {
  const result = await callFluidAudioHelper(options.fluidAudioHelperPath, {
    op: "transcribe",
    audioPath: options.audioPath,
    language: options.language || "",
    modelVersion: fluidAudioModelVersion(options.model),
  });
  const text = String(result.text || "").trim();
  const workerDurationMs = Number(result.workerDurationMs || 0);
  const resolvedModel = result.model || `FluidAudio Parakeet TDT ${fluidAudioModelVersion(options.model)}`;
  logEvent("audio:fluid-result", {
    engine: "fluid-parakeet",
    model: resolvedModel,
    language: options.language || "auto",
    textLength: text.length,
    textPreview: transcriptPreview(text),
    meaningful: hasMeaningfulTranscript(text),
    workerDurationMs,
    confidence: result.confidence ?? null,
  });
  return {
    text,
    model: resolvedModel,
    engine: "fluid-parakeet",
    workerDurationMs,
    audioDurationMs: Number(result.audioDurationMs || 0),
  };
}

function hasMeaningfulTranscript(text) {
  const value = String(text || "")
    .replace(/[\s.,;:!?¿¡'"`´“”‘’()[\]{}<>/\\|_*~=-]+/g, "")
    .trim();
  const matches = value.match(/[\p{L}\p{N}]/gu) || [];
  return matches.length >= 2;
}

function shouldRetryWithAutoLanguage(text, audioDurationMs = 0) {
  if (!hasMeaningfulTranscript(text)) return true;

  const words = String(text || "").match(/[\p{L}\p{N}]+/gu) || [];
  if (audioDurationMs < 1800) return false;
  return words.length <= 2 && String(text || "").trim().length <= 24;
}

function transcriptPreview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function estimatePcmWavDurationMs(bytes, sampleRate, channels, bitsPerSample) {
  const dataBytes = Math.max(0, Number(bytes || 0) - 44);
  const bytesPerSecond = Number(sampleRate || 0) * Number(channels || 0) * (Number(bitsPerSample || 0) / 8);
  if (!bytesPerSecond) return 0;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

function estimatePcmWavDurationMsFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return 0;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (id === "fmt " && start + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      dataBytes = Math.min(size, Math.max(0, buffer.length - start));
      break;
    }

    offset = start + size + (size % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond || !dataBytes) return 0;
  return Math.round((dataBytes / bytesPerSecond) * 1000);
}

function normalizeAudioStats(stats = {}) {
  return {
    samples: Number(stats.samples || 0),
    rms: Number(stats.rms || 0),
    peak: Number(stats.peak || 0),
  };
}

function shouldNormalizeAudio(stats = {}) {
  const samples = Number(stats.samples || 0);
  const peak = Number(stats.peak || 0);
  const rms = Number(stats.rms || 0);
  if (!samples || (!peak && !rms)) return false;
  return peak < 0.08 || rms < 0.008;
}

async function transcribeWithWhisperCli(options, tempDir) {
  await ensureRuntimeCacheDirs();
  const args = buildWhisperArgs(options);
  const { stdout, stderr } = await execFileAsync(options.command, args, {
    cwd: tempDir,
    env: pathSearchEnv(),
    timeout: 10 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return readWhisperText(tempDir, stdout, stderr);
}

function canUseWarmWhisperWorker(options) {
  if (options.template.trim() || options.modelPath) return false;
  const commandName = path.basename(options.command).toLowerCase();
  return !(commandName.includes("whisper-cli") || commandName === "main");
}

async function warmFluidAudioHelperInBackground() {
  if (warmFluidAudioHelperPromise) return warmFluidAudioHelperPromise;
  warmFluidAudioHelperPromise = (async () => {
    const settings = await readSettings();
    const helperPath = await resolveFluidAudioHelperPath();
    if (!helperPath) return;

    const primaryStreamingVariant = fluidAudioStreamingVariant(
      settings.localFluidAudioStreamingVariant || DEFAULT_FLUID_AUDIO_STREAMING_VARIANT,
    );
    const streamingVariants = [...new Set([
      primaryStreamingVariant,
      "nemotron-multilingual-latin-1120ms",
    ])];

    for (const streamingVariant of streamingVariants) {
      const started = Date.now();
      const language = streamingVariant.startsWith("nemotron-multilingual") ? "es" : undefined;
      logEvent("audio:fluid-stream-warm-start", { streamingVariant, language: language || "" });
      const result = await callFluidAudioHelper(helperPath, {
        op: "stream_warm",
        variant: streamingVariant,
        language,
      });
      logEvent("audio:fluid-stream-warm-result", {
        engine: result.engine || "fluid-streaming",
        model: result.model || "FluidAudio streaming",
        variant: result.variant || streamingVariant,
        language: language || "",
        durationMs: Date.now() - started,
        workerDurationMs: Number(result.workerDurationMs || 0),
      });
    }
  })().catch((error) => {
    logEvent("audio:fluid-stream-warm-failed", errorDetails(error));
    stopFluidAudioHelper();
  }).finally(() => {
    warmFluidAudioHelperPromise = null;
  });
  return warmFluidAudioHelperPromise;
}

async function warmWhisperWorkerInBackground() {
  if (warmWhisperWorkerPromise) return warmWhisperWorkerPromise;
  warmWhisperWorkerPromise = (async () => {
    const started = Date.now();
    const settings = await readSettings();
    const speechEngine = normalizeSpeechEngine(settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE);
    if (speechEngine === "fluid-parakeet") {
      await warmFluidAudioHelperInBackground();
      return;
    }
    const command = speechEngine === "mlx-parakeet"
      ? await resolveMlxParakeetCommand()
      : speechEngine === "mlx-whisper"
        ? await resolveMlxWhisperCommand()
        : await resolveCommand(settings.localWhisperCommand || DEFAULT_LOCAL_WHISPER_COMMAND);
    if (!command) return;

    const options = {
      command,
      engine: speechEngine,
      audioPath: "",
      outputDir: "",
      outputBase: "",
      language: "",
      model: speechEngine === "mlx-parakeet"
        ? settings.localParakeetModel || DEFAULT_LOCAL_PARAKEET_MODEL
        : settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL,
      modelPath: settings.localWhisperModelPath || "",
      template: settings.localWhisperArgs || "",
    };
    if (!canUseWarmWhisperWorker(options)) return;

    logEvent("audio:warm-start", {
      engine: speechEngine,
      model: options.model,
    });
    const result = await callWhisperWorker(command, {
      op: "warm",
      model: options.model,
      engine: workerEngineForSpeechEngine(speechEngine),
    });
    logEvent("audio:warm-result", {
      engine: result.engine || speechEngine,
      model: result.model || options.model,
      durationMs: Date.now() - started,
    });
  })().catch((error) => {
    logEvent("audio:warm-failed", errorDetails(error));
    stopWhisperWorker();
  }).finally(() => {
    warmWhisperWorkerPromise = null;
  });
  return warmWhisperWorkerPromise;
}

async function warmFallbackWhisperInBackground() {
  if (warmFallbackWhisperPromise) return warmFallbackWhisperPromise;
  if (dictationState !== "idle" || whisperWorkerRequests.size) {
    setTimeout(() => warmFallbackWhisperInBackground(), 5000);
    return null;
  }

  warmFallbackWhisperPromise = (async () => {
    const settings = await readSettings();
    const speechEngine = normalizeSpeechEngine(settings.localSpeechEngine || settings.transcriptionEngine || DEFAULT_SPEECH_ENGINE);
    if (speechEngine !== "mlx-parakeet" && speechEngine !== "fluid-parakeet") return;

    const command = await resolveMlxWhisperCommand();
    if (!command) return;

    const options = {
      command,
      engine: "mlx-whisper",
      audioPath: "",
      outputDir: "",
      outputBase: "",
      language: "",
      model: settings.localWhisperModel || DEFAULT_LOCAL_WHISPER_MODEL,
      modelPath: "",
      template: "",
    };
    if (!canUseWarmWhisperWorker(options)) return;

    const started = Date.now();
    logEvent("audio:fallback-warm-start", {
      engine: options.engine,
      model: options.model,
    });
    const result = await callWhisperWorker(command, {
      op: "warm",
      model: options.model,
      engine: "mlx",
    });
    logEvent("audio:fallback-warm-result", {
      engine: result.engine || options.engine,
      model: result.model || options.model,
      durationMs: Date.now() - started,
    });
  })().catch((error) => {
    logEvent("audio:fallback-warm-failed", errorDetails(error));
  }).finally(() => {
    warmFallbackWhisperPromise = null;
  });
  return warmFallbackWhisperPromise;
}

async function callWhisperWorker(command, request) {
  const worker = await ensureWhisperWorker(command);
  if (!worker.stdin.writable) throw new Error("Local Whisper worker is not writable.");

  const id = String(++whisperWorkerRequestId);
  const payload = { ...request, id };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      whisperWorkerRequests.delete(id);
      reject(new Error("Local Whisper worker timed out."));
      stopWhisperWorker();
    }, 10 * 60 * 1000);

    whisperWorkerRequests.set(id, { resolve, reject, timeout });
    worker.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      rejectWhisperWorkerRequest(id, error);
    });
  });
}

async function ensureWhisperWorker(command) {
  const python = await resolveWhisperPython(command);
  if (!python) {
    throw new Error("Could not find a Python environment with a supported local Whisper runtime.");
  }

  await ensureRuntimeCacheDirs();
  const workerPath = await materializeWhisperWorkerScript();
  const key = JSON.stringify([python.command, python.args, workerPath]);
  if (
    whisperWorker &&
    !whisperWorker.killed &&
    whisperWorker.exitCode === null &&
    whisperWorkerKey === key
  ) {
    return whisperWorker;
  }

  stopWhisperWorker();
  whisperWorkerStderr = "";
  whisperWorkerKey = key;
  const child = spawn(python.command, [...python.args, "-u", workerPath], {
    env: pathSearchEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  whisperWorker = child;

  child.stdout.setEncoding("utf8");
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", handleWhisperWorkerLine);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    whisperWorkerStderr = `${whisperWorkerStderr}${chunk}`.slice(-12000);
  });

  child.on("error", (error) => {
    rejectAllWhisperWorkerRequests(error);
    if (whisperWorker === child) whisperWorker = null;
  });

  child.on("exit", (code, signal) => {
    const detail = summarizeToolOutput(whisperWorkerStderr);
    const reason = signal || `code ${code}`;
    rejectAllWhisperWorkerRequests(
      new Error(
        detail
          ? `Local Whisper worker stopped (${reason}). ${detail}`
          : `Local Whisper worker stopped (${reason}).`,
      ),
    );
    if (whisperWorker === child) whisperWorker = null;
    whisperWorkerKey = "";
  });

  return child;
}

function handleWhisperWorkerLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;

  let message = null;
  try {
    message = JSON.parse(trimmed);
  } catch {
    whisperWorkerStderr = `${whisperWorkerStderr}\n${trimmed}`.slice(-12000);
    return;
  }

  const pending = whisperWorkerRequests.get(String(message.id));
  if (!pending) return;
  whisperWorkerRequests.delete(String(message.id));
  clearTimeout(pending.timeout);

  if (message.ok) {
    pending.resolve(message);
    return;
  }

  const detail = [message.error, message.traceback]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1600);
  pending.reject(new Error(detail || "Local Whisper worker failed."));
}

function rejectWhisperWorkerRequest(id, error) {
  const pending = whisperWorkerRequests.get(String(id));
  if (!pending) return;
  whisperWorkerRequests.delete(String(id));
  clearTimeout(pending.timeout);
  pending.reject(error);
}

function rejectAllWhisperWorkerRequests(error) {
  for (const [id, pending] of whisperWorkerRequests) {
    whisperWorkerRequests.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
}

function stopWhisperWorker() {
  if (!whisperWorker) return;
  const child = whisperWorker;
  whisperWorker = null;
  whisperWorkerKey = "";
  rejectAllWhisperWorkerRequests(new Error("Local Whisper worker was stopped."));
  if (!child.killed && child.exitCode === null) child.kill();
}

async function callFluidAudioHelper(helperPath, request) {
  const helper = await ensureFluidAudioHelper(helperPath);
  if (!helper.stdin.writable) throw new Error("FluidAudio helper is not writable.");

  const id = String(++fluidAudioHelperRequestId);
  const payload = { ...request, id };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      fluidAudioHelperRequests.delete(id);
      reject(new Error("FluidAudio helper timed out."));
      stopFluidAudioHelper();
    }, 5 * 60 * 1000);

    fluidAudioHelperRequests.set(id, { resolve, reject, timeout });
    helper.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      rejectFluidAudioHelperRequest(id, error);
    });
  });
}

async function ensureFluidAudioHelper(helperPath) {
  if (!helperPath) throw new Error("FluidAudio helper path is missing.");
  const key = helperPath;
  if (
    fluidAudioHelper &&
    !fluidAudioHelper.killed &&
    fluidAudioHelper.exitCode === null &&
    fluidAudioHelperKey === key
  ) {
    return fluidAudioHelper;
  }

  stopFluidAudioHelper();
  fluidAudioHelperStderr = "";
  fluidAudioHelperKey = key;
  const child = spawn(helperPath, [], {
    env: pathSearchEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  fluidAudioHelper = child;

  child.stdout.setEncoding("utf8");
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", handleFluidAudioHelperLine);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    fluidAudioHelperStderr = `${fluidAudioHelperStderr}${chunk}`.slice(-12000);
  });

  child.on("error", (error) => {
    rejectAllFluidAudioHelperRequests(error);
    if (fluidAudioHelper === child) fluidAudioHelper = null;
  });

  child.on("exit", (code, signal) => {
    const detail = summarizeToolOutput(fluidAudioHelperStderr);
    const reason = signal || `code ${code}`;
    rejectAllFluidAudioHelperRequests(
      new Error(
        detail
          ? `FluidAudio helper stopped (${reason}). ${detail}`
          : `FluidAudio helper stopped (${reason}).`,
      ),
    );
    if (fluidAudioHelper === child) fluidAudioHelper = null;
    fluidAudioHelperKey = "";
  });

  return child;
}

function handleFluidAudioHelperLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;

  let message = null;
  try {
    message = JSON.parse(trimmed);
  } catch {
    fluidAudioHelperStderr = `${fluidAudioHelperStderr}\n${trimmed}`.slice(-12000);
    return;
  }

  const pending = fluidAudioHelperRequests.get(String(message.id));
  if (!pending) return;
  fluidAudioHelperRequests.delete(String(message.id));
  clearTimeout(pending.timeout);

  if (message.ok) {
    pending.resolve(message);
    return;
  }

  pending.reject(new Error(String(message.error || "FluidAudio helper failed.").slice(0, 1600)));
}

function rejectFluidAudioHelperRequest(id, error) {
  const pending = fluidAudioHelperRequests.get(String(id));
  if (!pending) return;
  fluidAudioHelperRequests.delete(String(id));
  clearTimeout(pending.timeout);
  pending.reject(error);
}

function rejectAllFluidAudioHelperRequests(error) {
  for (const [id, pending] of fluidAudioHelperRequests) {
    fluidAudioHelperRequests.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
}

function stopFluidAudioHelper() {
  if (!fluidAudioHelper) return;
  const child = fluidAudioHelper;
  fluidAudioHelper = null;
  fluidAudioHelperKey = "";
  rejectAllFluidAudioHelperRequests(new Error("FluidAudio helper was stopped."));
  if (!child.killed && child.exitCode === null) child.kill();
}

async function materializeWhisperWorkerScript() {
  if (materializedWhisperWorkerPath) return materializedWhisperWorkerPath;
  const sourcePath = path.join(__dirname, "whisper_worker.py");
  const targetDir = app.getPath("userData");
  const targetPath = path.join(targetDir, "whisper_worker.py");
  const source = await fs.readFile(sourcePath, "utf8");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, source);
  materializedWhisperWorkerPath = targetPath;
  return targetPath;
}

async function resolveWhisperPython(command) {
  const mlxPython = path.join(
    app.getPath("userData"),
    "runtimes/mlx-whisper/bin/python",
  );
  if (await fileExists(mlxPython)) return { command: mlxPython, args: [] };

  const realCommand = await fs.realpath(command).catch(() => command);
  const siblingPython = path.join(path.dirname(realCommand), "python");
  if (await fileExists(siblingPython)) return { command: siblingPython, args: [] };

  const pipxPython = path.join(os.homedir(), ".local/pipx/venvs/openai-whisper/bin/python");
  if (await fileExists(pipxPython)) return { command: pipxPython, args: [] };

  try {
    const firstLine = (await fs.readFile(realCommand, "utf8")).split(/\r?\n/, 1)[0] || "";
    if (!firstLine.startsWith("#!")) return null;
    const parts = splitArgs(firstLine.slice(2).trim());
    if (!parts.length) return null;

    const executableName = path.basename(parts[0]);
    if (executableName === "env") {
      const pythonIndex = parts.findIndex((part, index) => index > 0 && !part.startsWith("-"));
      if (pythonIndex === -1) return null;
      const resolved = await resolveCommand(parts[pythonIndex]);
      if (!resolved) return null;
      return { command: resolved, args: parts.slice(pythonIndex + 1) };
    }

    if (executableName.startsWith("python")) {
      return { command: parts[0], args: parts.slice(1) };
    }
  } catch {
    // Fall back to the CLI path if the worker cannot find a Python runtime.
  }
  return null;
}

function normalizeSpeechEngine(engine) {
  const value = String(engine || "").trim().toLowerCase();
  if (value === "fluid" || value === "fluid-audio" || value === "fluidaudio" || value === "fluid-parakeet") return "fluid-parakeet";
  if (value === "mlx" || value === "mlx-whisper") return "mlx-whisper";
  if (value === "parakeet" || value === "mlx-parakeet" || value === "parakeet-mlx") return "mlx-parakeet";
  if (value === "openai" || value === "openai-whisper" || value === "whisper") return "openai-whisper";
  if (value === "whisper-cli" || value === "whisper.cpp") return "whisper-cli";
  return DEFAULT_SPEECH_ENGINE;
}

function workerEngineForSpeechEngine(engine) {
  const value = normalizeSpeechEngine(engine);
  if (value === "mlx-whisper") return "mlx";
  if (value === "mlx-parakeet") return "parakeet";
  return "openai";
}

async function preferredWhisperEngine() {
  const mlxPython = path.join(
    app.getPath("userData"),
    "runtimes/mlx-whisper/bin/python",
  );
  if (await fileExists(mlxPython)) return "mlx-whisper";
  if (await resolveCommand("mlx-whisper")) return "mlx-whisper";
  return "";
}

async function resolveMlxWhisperCommand() {
  const mlxPython = path.join(
    app.getPath("userData"),
    "runtimes/mlx-whisper/bin/python",
  );
  if (await fileExists(mlxPython)) return "mlx-whisper";
  return await resolveCommand("mlx-whisper");
}

async function resolveMlxParakeetCommand() {
  const runtimeCommand = path.join(
    app.getPath("userData"),
    "runtimes/mlx-whisper/bin/parakeet-mlx",
  );
  if (await fileExists(runtimeCommand)) return runtimeCommand;
  return await resolveCommand("parakeet-mlx");
}

async function resolveFluidAudioHelperPath() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "native/bin", FLUID_AUDIO_HELPER_NAME),
      path.join(process.resourcesPath, "native/bin", FLUID_AUDIO_HELPER_NAME),
    );
  }
  candidates.push(
    path.join(__dirname, "native/bin", FLUID_AUDIO_HELPER_NAME),
    path.join(__dirname, "native/fluid-helper/.build/release", FLUID_AUDIO_HELPER_NAME),
  );

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "";
}

function fluidAudioModelVersion(model = "") {
  const value = String(model || "").trim().toLowerCase();
  if (value === "v2" || value.includes("0.6b-v2")) return "v2";
  return "v3";
}

function fluidAudioStreamingVariant(variant = "") {
  const value = String(variant || "").trim().toLowerCase();
  const supported = new Set([
    "parakeet-unified-320ms",
    "parakeet-unified-640ms",
    "parakeet-unified-1120ms",
    "parakeet-unified-2080ms",
    "parakeet-eou-160ms",
    "parakeet-eou-320ms",
    "parakeet-eou-1280ms",
    "nemotron-560ms",
    "nemotron-1120ms",
    "nemotron-2240ms",
    "nemotron-multilingual-latin-560ms",
    "nemotron-multilingual-latin-1120ms",
    "nemotron-multilingual-latin-2240ms",
    "nemotron-multilingual-latin-4480ms",
    "nemotron-multilingual-560ms",
    "nemotron-multilingual-1120ms",
    "nemotron-multilingual-2240ms",
    "nemotron-multilingual-4480ms",
  ]);
  return supported.has(value) ? value : DEFAULT_FLUID_AUDIO_STREAMING_VARIANT;
}

function parakeetSupportsLanguage(language) {
  return PARAKEET_SUPPORTED_LANGUAGES.has(String(language || "").trim().toLowerCase());
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function audioExtensionForPayload(payload) {
  const filename = String(payload.filename || "").toLowerCase();
  const mimeType = String(payload.mimeType || "").toLowerCase();
  if (filename.endsWith(".m4a") || filename.endsWith(".mp4") || mimeType.includes("mp4")) return ".m4a";
  if (filename.endsWith(".ogg") || mimeType.includes("ogg")) return ".ogg";
  if (filename.endsWith(".wav") || mimeType.includes("wav")) return ".wav";
  if (filename.endsWith(".webm") || mimeType.includes("webm")) return ".webm";
  return ".webm";
}

function buildWhisperArgs(options) {
  if (options.template.trim()) {
    return splitArgs(options.template).map((arg) =>
      arg
        .replaceAll("{audio}", options.audioPath)
        .replaceAll("{wav}", options.audioPath)
        .replaceAll("{dir}", options.outputDir)
        .replaceAll("{outbase}", options.outputBase)
        .replaceAll("{model}", options.modelPath || options.model)
        .replaceAll("{language}", options.language || "auto"),
    );
  }

  const commandName = path.basename(options.command).toLowerCase();
  if (commandName.includes("whisper-cli") || commandName === "main") {
    if (!options.modelPath) {
      throw new Error("Set a whisper.cpp model path in Settings.");
    }
    const args = ["-m", options.modelPath, "-f", options.audioPath, "-otxt", "-of", options.outputBase];
    if (options.language) args.push("-l", options.language);
    return args;
  }

  const args = [
    options.audioPath,
    "--model",
    options.model || DEFAULT_LOCAL_WHISPER_MODEL,
    "--task",
    "transcribe",
    "--output_format",
    "txt",
    "--output_dir",
    options.outputDir,
    "--temperature",
    "0",
    "--condition_on_previous_text",
    "False",
    "--compression_ratio_threshold",
    "1.8",
    "--logprob_threshold",
    "-1.0",
    "--no_speech_threshold",
    "0.55",
    "--fp16",
    "False",
    "--verbose",
    "False",
  ];
  if (options.language) args.push("--language", options.language);
  return args;
}

async function readWhisperText(tempDir, stdout, stderr) {
  const txtFiles = await findFiles(tempDir, ".txt");
  for (const file of txtFiles) {
    const text = (await fs.readFile(file, "utf8")).trim();
    if (text) return text;
  }

  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  const diagnostic = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+%/.test(line))
    .filter((line) => !/\|\s*\d+(\.\d+)?[kM]?\/\d+/.test(line))
    .filter((line) => !/^ffmpeg version/i.test(line))
    .filter((line) => !/^configuration:/i.test(line))
    .filter((line) => !/^lib(av|sw|postproc)/i.test(line))
    .slice(0, 4)
    .join(" ");
  throw new Error(
    diagnostic
      ? `Local Whisper did not produce a transcript. ${diagnostic}`
      : "Local Whisper finished without transcript text.",
  );
}

function summarizeToolOutput(output) {
  const text = String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^ffmpeg version/i.test(line))
    .filter((line) => !/^configuration:/i.test(line))
    .filter((line) => !/^lib(av|sw|postproc)/i.test(line))
    .slice(-4)
    .join(" ");
  return text.slice(0, 700);
}

async function findFiles(root, suffix) {
  const results = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFiles(fullPath, suffix)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      results.push(fullPath);
    }
  }
  return results;
}

ipcMain.handle("text:insert", async (_event, text, options = {}) => {
  return insertTextIntoTarget(text, options);
});

async function runInsertSelfTest(text, targetOverride = null) {
  const target = targetOverride || await refreshPasteTarget("self-test") || recentPasteTarget;
  const result = await insertTextIntoTarget(text, {
    background: true,
    targetOverride: target,
  });
  logEvent("self-test:insert-result", {
    result: {
      ok: Boolean(result?.ok),
      copied: Boolean(result?.copied),
      message: result?.message || "",
      permissionRequired: Boolean(result?.permissionRequired),
    },
    target: describePasteTarget(target),
  });
  return result;
}

async function insertTextIntoTarget(text, options = {}) {
  const value = String(text || "");
  if (!value.trim()) return { ok: false, message: "No text to insert." };
  let target = options.targetOverride || (options.background ? lastDictationTarget || recentPasteTarget : null);

  try {
    clipboard.writeText(value);
  } catch (error) {
    logEvent("text:clipboard-write-failed", errorDetails(error));
    return { ok: false, message: "Could not copy the transcript to the clipboard." };
  }

  if (process.platform !== "darwin") {
    return { ok: true, copied: true, message: "Copied to clipboard." };
  }

  try {
    if (options.background && !target) {
      target = await refreshPasteTarget("insert-fallback");
    }

    if (!hasAccessibilityPermission(false)) {
      return {
        ok: false,
        copied: true,
        permissionRequired: true,
        message: "Text copied. Enable Accessibility so ShadiFlow can paste automatically.",
      };
    }

    if (options.background && !target) {
      logEvent("text:insert-missing-target", { textLength: value.length });
      return {
        ok: false,
        copied: true,
        message: "Text copied, but ShadiFlow could not find the target app.",
      };
    }

    const activatedTarget = target ? await activatePasteTarget(target) : true;
    if (target && !activatedTarget) {
      logEvent("text:insert-target-activation-failed", {
        target: describePasteTarget(target),
        textLength: value.length,
      });
      return {
        ok: false,
        copied: true,
        message: "Text copied, but ShadiFlow could not switch back to the target app.",
      };
    }
    const result = await pasteClipboardIntoActiveApp();
    logEvent("text:insert-result", {
      ok: Boolean(result.ok),
      copied: true,
      permissionRequired: Boolean(result.permissionRequired),
      target: describePasteTarget(target),
      textLength: value.length,
    });
    return result;
  } catch (error) {
    logEvent("text:insert-failed", {
      ...errorDetails(error),
      target: describePasteTarget(target),
      textLength: value.length,
    });
    return {
      ok: false,
      copied: true,
      message: "Text copied to clipboard, but automatic paste failed.",
    };
  }
}

ipcMain.handle("text:copy", async (_event, text) => {
  const value = String(text || "");
  if (!value.trim()) return { ok: false, message: "No text to copy." };
  clipboard.writeText(value);
  return { ok: true, message: "Copied." };
});

ipcMain.handle("permissions:accessibility", async (_event, prompt = false) => {
  return { trusted: hasAccessibilityPermission(Boolean(prompt)) };
});

ipcMain.handle("permissions:open-accessibility-settings", async () => {
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  return { ok: true };
});

ipcMain.handle("overlay:hide", async () => {
  if (dictationState === "recording") {
    sendRecordingCancelCommand("overlay-close");
    dictationState = "idle";
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  return { ok: true };
});

function hasAccessibilityPermission(prompt = false) {
  if (process.platform !== "darwin") return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch {
    return false;
  }
}

async function activatePasteTarget(target) {
  if (!target) return false;
  if (Number.isFinite(Number(target.pid)) && Number(target.pid) > 0 && hasAccessibilityPermission(false)) {
    try {
      await execFileAsync(
        "/usr/bin/osascript",
        ["-e", `tell application "System Events" to set frontmost of first application process whose unix id is ${Number(target.pid)} to true`],
        { timeout: 1200 },
      );
      await sleep(140);
      return true;
    } catch (error) {
      logEvent("paste:activate-pid-failed", {
        ...errorDetails(error),
        pid: Number(target.pid),
        name: target.name || "",
      });
    }
  }

  if (target.bundle) {
    try {
      await execFileAsync("/usr/bin/open", ["-b", target.bundle], { timeout: 1200 });
      await sleep(160);
      return true;
    } catch (error) {
      logEvent("paste:activate-bundle-failed", {
        ...errorDetails(error),
        bundle: target.bundle,
        name: target.name || "",
      });
      // Fall back to activating by app name below.
    }
  }

  if (!target.name) return false;
  try {
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", `tell application ${JSON.stringify(target.name)} to activate`],
      { timeout: 1200 },
    );
    await sleep(160);
    return true;
  } catch (error) {
    logEvent("paste:activate-name-failed", {
      ...errorDetails(error),
      name: target.name,
    });
    // If activation fails, the paste attempt still uses the current active app.
  }
  return false;
}

function pasteClipboardIntoActiveApp() {
  return new Promise((resolve) => {
    if (!hasAccessibilityPermission(false)) {
      resolve({
        ok: false,
        permissionRequired: true,
        message: "Text copied. Enable Accessibility so ShadiFlow can paste automatically.",
      });
      return;
    }

    setTimeout(() => {
      execFile(
        "/usr/bin/osascript",
        ["-e", 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: 1600 },
        (error, _stdout, stderr) => {
          if (error) {
            logEvent("paste:keystroke-failed", {
              ...errorDetails(error),
              stderr: summarizeToolOutput(stderr),
            });
            resolve({
              ok: false,
              copied: true,
              permissionRequired: !hasAccessibilityPermission(false),
              message: hasAccessibilityPermission(false)
                ? "Text copied to clipboard, but the active app did not accept automatic paste."
                : "Text copied. Enable Accessibility so ShadiFlow can paste automatically.",
            });
            return;
          }
          resolve({ ok: true, copied: true, message: "Inserted into active app." });
        },
      );
    }, 120);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

ipcMain.handle("app:open-settings-folder", async () => {
  await shell.openPath(app.getPath("userData"));
});

async function commandExists(command) {
  return Boolean(await resolveCommand(command));
}

async function resolveCommand(command) {
  if (!command) return "";
  const cacheKey = String(command);
  if (resolvedCommandCache.has(cacheKey)) return resolvedCommandCache.get(cacheKey);
  if (command.includes("/")) {
    try {
      await fs.access(command);
      resolvedCommandCache.set(cacheKey, command);
      return command;
    } catch {
      return "";
    }
  }
  try {
    const { stdout } = await execFileAsync("which", [command], {
      env: pathSearchEnv(),
      timeout: 3000,
    });
    const resolved = stdout.trim().split("\n")[0];
    if (resolved) {
      resolvedCommandCache.set(cacheKey, resolved);
      return resolved;
    }
  } catch {
    // Continue to common Finder-launched app paths below.
  }

  for (const candidate of commonCommandPaths(command)) {
    try {
      await fs.access(candidate);
      resolvedCommandCache.set(cacheKey, candidate);
      return candidate;
    } catch {
      // Try the next likely location.
    }
  }
  return "";
}

function pathSearchEnv() {
  const extraPath = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), "Library/Python/3.13/bin"),
    path.join(os.homedir(), "Library/Python/3.12/bin"),
    path.join(os.homedir(), "Library/Python/3.11/bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const runtimeCacheDir = path.join(app.getPath("userData"), "runtime-cache");
  return {
    ...process.env,
    PATH: `${extraPath}:${process.env.PATH || ""}`,
    XDG_CACHE_HOME: runtimeCacheDir,
    MPLCONFIGDIR: path.join(runtimeCacheDir, "matplotlib"),
    HF_HOME: path.join(runtimeCacheDir, "huggingface"),
    TORCH_HOME: path.join(runtimeCacheDir, "torch"),
    NUMBA_CACHE_DIR: path.join(runtimeCacheDir, "numba"),
    LHOTSE_TOOLS: path.join(runtimeCacheDir, "lhotse-tools"),
    PYTORCH_ENABLE_MPS_FALLBACK: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
}

async function ensureRuntimeCacheDirs() {
  const runtimeCacheDir = path.join(app.getPath("userData"), "runtime-cache");
  await Promise.all([
    fs.mkdir(runtimeCacheDir, { recursive: true }),
    fs.mkdir(path.join(runtimeCacheDir, "matplotlib"), { recursive: true }),
    fs.mkdir(path.join(runtimeCacheDir, "huggingface"), { recursive: true }),
    fs.mkdir(path.join(runtimeCacheDir, "torch"), { recursive: true }),
    fs.mkdir(path.join(runtimeCacheDir, "numba"), { recursive: true }),
    fs.mkdir(path.join(runtimeCacheDir, "lhotse-tools"), { recursive: true }),
  ]);
}

function commonCommandPaths(command) {
  return [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    path.join(os.homedir(), ".local/bin", command),
    path.join(os.homedir(), "Library/Python/3.13/bin", command),
    path.join(os.homedir(), "Library/Python/3.12/bin", command),
    path.join(os.homedir(), "Library/Python/3.11/bin", command),
  ];
}

function splitArgs(input) {
  const matches = String(input).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) return;
  ensureDockPresence();
  try {
    await migrateFluidAudioSettings();
  } catch (error) {
    logEvent("settings:migrate-fluid-audio-failed", errorDetails(error));
  }
  createWindow();
  registerShortcut();
  startPasteTargetPolling();
  setTimeout(() => {
    warmWhisperWorkerInBackground();
  }, 150);
  setTimeout(() => {
    warmFallbackWhisperInBackground();
  }, 12000);

  app.on("activate", () => {
    presentMainWindow("activate");
  });
});

app.on("child-process-gone", (_event, details) => {
  logEvent("app:child-process-gone", details);
});

app.on("window-all-closed", () => {
  logEvent("app:window-all-closed", { platform: process.platform });
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  logEvent("app:before-quit");
  isQuitting = true;
});

app.on("quit", (_event, exitCode) => {
  logEvent("app:quit", { exitCode });
});

app.on("will-quit", () => {
  logEvent("app:will-quit");
  clearInterval(targetPollTimer);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  stopWhisperWorker();
  stopFluidAudioHelper();
  globalShortcut.unregisterAll();
});
