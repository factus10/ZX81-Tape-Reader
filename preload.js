const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onInputFile: (callback) => {
    ipcRenderer.on("inputFile", (_event, filePath) => callback(filePath));
  },

  onLoadSession: (callback) => {
    ipcRenderer.on("loadSession", (_event, session) => callback(session));
  },

  onMenuAction: (callback) => {
    ipcRenderer.on("menuAction", (_event, action) => callback(action));
  },

  processWavFile: (filePath, options) => {
    return ipcRenderer.invoke("process-wav-file", filePath, options);
  },

  redecodeWavFile: (filePath, options) => {
    return ipcRenderer.invoke("redecode-wav-file", filePath, options);
  },

  encodeToTzx: (rawData) => {
    return ipcRenderer.invoke("encode-to-tzx", rawData);
  },

  saveFile: (dataArray, defaultFileName, fileType) => {
    return ipcRenderer.invoke("save-file", dataArray, defaultFileName, fileType);
  },

  saveSession: (sessionData, filePath) => {
    return ipcRenderer.invoke("save-session", sessionData, filePath);
  },

  decodeZx81Bytes: (rawData) => {
    return ipcRenderer.invoke("decode-zx81-bytes", rawData);
  },
});
