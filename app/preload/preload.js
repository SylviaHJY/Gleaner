import { contextBridge, ipcRenderer } from "electron";

const api = {
  getState: () => ipcRenderer.invoke("vocab:get-state"),
  listEntries: (options) => ipcRenderer.invoke("vocab:list-entries", options),
  listHistory: (options) => ipcRenderer.invoke("vocab:list-history", options),
  getEntry: (entryId) => ipcRenderer.invoke("vocab:get-entry", entryId),
  updateSettings: (partial) => ipcRenderer.invoke("vocab:update-settings", partial),
  addEntry: (input) => ipcRenderer.invoke("vocab:add-entry", input),
  updateEntry: (payload) => ipcRenderer.invoke("vocab:update-entry", payload),
  deleteEntry: (entryId) => ipcRenderer.invoke("vocab:delete-entry", entryId),
  favoriteExample: (payload) => ipcRenderer.invoke("vocab:favorite-example", payload),
  recordReview: (payload) => ipcRenderer.invoke("vocab:record-review", payload),
  enrichEntry: (entryId) => ipcRenderer.invoke("vocab:enrich-entry", entryId),
  setWindowMode: (mode) => ipcRenderer.invoke("vocab:set-window-mode", mode),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  quitApp: () => ipcRenderer.invoke("window:quit")
};

contextBridge.exposeInMainWorld("vocabApi", api);
