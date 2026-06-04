import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataStore } from "./dataStore.js";
import { enrichTerm } from "./dictionary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSmokeTest = process.argv.includes("--smoke-test");

let mainWindow;
let store;
let tray;
let currentMode = "study";
let windowStatePath = null;
let isQuitting = false;
let reminderTimer = null;

const STUDY_SIZE = { width: 440, height: 660 };
const SETTINGS_SIZE = { width: 900, height: 660 };
const STUDY_MIN = { width: 360, height: 480 };
const WINDOW_MARGIN = 18;

function getCurrentDisplay() {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function getBottomRightBounds(size = STUDY_SIZE) {
  const area = getCurrentDisplay().workArea;
  return {
    width: size.width,
    height: size.height,
    x: Math.round(area.x + area.width - size.width - WINDOW_MARGIN),
    y: Math.round(area.y + area.height - size.height - WINDOW_MARGIN)
  };
}

function getCenteredBounds(size = SETTINGS_SIZE) {
  const area = getCurrentDisplay().workArea;
  return {
    width: size.width,
    height: size.height,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + (area.height - size.height) / 2)
  };
}

function isBoundsVisible(bounds) {
  const centerX = bounds.x + bounds.width / 2;
  const topY = bounds.y + 20;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      centerX >= area.x &&
      centerX <= area.x + area.width &&
      topY >= area.y &&
      topY <= area.y + area.height
    );
  });
}

function loadStudyBounds() {
  if (!windowStatePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath, "utf8"));
    if (
      parsed &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height) &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function saveStudyBounds(bounds) {
  if (!windowStatePath) return;
  try {
    fs.writeFileSync(windowStatePath, JSON.stringify(bounds));
  } catch (error) {
    console.warn("Unable to persist window bounds:", error);
  }
}

function getStudyBounds() {
  const saved = loadStudyBounds();
  if (saved && isBoundsVisible(saved)) return saved;
  return getBottomRightBounds();
}

function setWindowMode(mode) {
  if (!mainWindow) return;
  currentMode = mode === "settings" ? "settings" : "study";

  if (currentMode === "settings") {
    mainWindow.setResizable(true);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setBounds(getCenteredBounds(), true);
    return;
  }

  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(STUDY_MIN.width, STUDY_MIN.height);
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setBounds(getStudyBounds(), false);
}

function persistCurrentBounds() {
  if (currentMode !== "study" || !mainWindow || mainWindow.isDestroyed()) return;
  saveStudyBounds(mainWindow.getBounds());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

function parseClock(value, fallbackMinutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return fallbackMinutes;
  const hours = Math.min(23, Math.max(0, Number(match[1])));
  const minutes = Math.min(59, Math.max(0, Number(match[2])));
  return hours * 60 + minutes;
}

function isWithinActiveHours(settings) {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseClock(settings.activeStart, 9 * 60 + 30);
  const end = parseClock(settings.activeEnd, 22 * 60 + 30);
  if (start === end) return true;
  if (start < end) return current >= start && current <= end;
  // Active window wraps past midnight.
  return current >= start || current <= end;
}

function scheduleReminders(settings) {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  if (!settings.reminderEnabled) return;
  const minutes = Number(settings.reminderMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  reminderTimer = setInterval(() => {
    const current = store?.getState().settings;
    if (!current || !current.reminderEnabled) return;
    if (!isWithinActiveHours(current)) return;
    showMainWindow();
  }, minutes * 60 * 1000);
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip("Vocabulary");
    tray.setTitle(" 词");
    const menu = Menu.buildFromTemplate([
      { label: "现在背一个", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "退出 Vocabulary",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => showMainWindow());
  } catch (error) {
    console.warn("Unable to create tray:", error);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    ...getStudyBounds(),
    minWidth: STUDY_MIN.width,
    minHeight: STUDY_MIN.height,
    title: "Vocabulary",
    frame: false,
    resizable: true,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on("moved", persistCurrentBounds);
  mainWindow.on("resized", persistCurrentBounds);

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.once("ready-to-show", () => {
    setWindowMode("study");
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }
}

function applyAutostart(settings) {
  if (!app.isReady()) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.autostart),
      openAsHidden: true
    });
  } catch (error) {
    console.warn("Unable to update login item settings:", error);
  }
}

function registerIpc() {
  ipcMain.handle("vocab:get-state", () => store.getState());

  ipcMain.handle("vocab:list-entries", (_event, options) => store.listLibraryEntries(options ?? {}));

  ipcMain.handle("vocab:list-history", (_event, options) => store.listHistoryEntries(options ?? {}));

  ipcMain.handle("vocab:get-entry", (_event, entryId) => store.getEntry(entryId));

  ipcMain.handle("vocab:update-settings", (_event, partial) => {
    const nextState = store.updateSettings(partial);
    applyAutostart(nextState.settings);
    scheduleReminders(nextState.settings);
    return nextState;
  });

  ipcMain.handle("vocab:add-entry", async (_event, input) => {
    const state = store.addEntry(input);
    const entry = store.findEntryByTerm(input.term);
    if (!entry) return state;
    const enrichment = await enrichTerm(entry.term, state.settings);
    return store.mergeEnrichment(entry.id, enrichment);
  });

  ipcMain.handle("vocab:update-entry", (_event, payload) => {
    return store.updateEntry(payload.entryId, payload.updates ?? {});
  });

  ipcMain.handle("vocab:delete-entry", (_event, entryId) => store.deleteEntry(entryId));

  ipcMain.handle("vocab:favorite-example", (_event, payload) => {
    return store.favoriteExample(payload.entryId, payload.exampleIndex);
  });

  ipcMain.handle("vocab:record-review", (_event, payload) => store.recordReview(payload));

  ipcMain.handle("vocab:set-window-mode", (_event, mode) => {
    setWindowMode(mode === "settings" ? "settings" : "study");
    return true;
  });

  ipcMain.handle("window:minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return true;
  });

  ipcMain.handle("window:hide", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    return true;
  });

  ipcMain.handle("window:quit", () => {
    isQuitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle("vocab:enrich-entry", async (_event, entryId) => {
    const state = store.getState();
    const entry = store.getEntry(entryId);
    if (!entry) throw new Error("Entry not found.");
    const enrichment = await enrichTerm(entry.term, state.settings);
    return store.mergeEnrichment(entryId, enrichment);
  });
}

const gotSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = "light";
    Menu.setApplicationMenu(null);
    windowStatePath = path.join(app.getPath("userData"), "window-state.json");
    store = new DataStore(app.getPath("userData"));
    if (isSmokeTest) {
      const state = store.getState();
      console.log(`smoke ok: ${state.storageKind}, entries=${state.entries.length}, today=${state.todaySession.entryIds.length}`);
      app.quit();
      return;
    }
    applyAutostart(store.getState().settings);
    registerIpc();
    createTray();
    createMainWindow();
    scheduleReminders(store.getState().settings);

    app.on("activate", () => {
      showMainWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
