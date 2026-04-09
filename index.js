const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

let win;
let helpWin;

function openWavFile() {
  dialog
    .showOpenDialog(win, {
      filters: [{ name: "WAV Files", extensions: ["wav"] }],
      properties: ["openFile"],
    })
    .then(({ canceled, filePaths }) => {
      if (!canceled && filePaths.length > 0) {
        win.webContents.send("inputFile", filePaths[0]);
      }
    });
}

function openSessionFile() {
  dialog
    .showOpenDialog(win, {
      filters: [{ name: "ZX81 Tape Reader Session", extensions: ["ztr"] }],
      properties: ["openFile"],
    })
    .then(({ canceled, filePaths }) => {
      if (!canceled && filePaths.length > 0) {
        const data = fs.readFileSync(filePaths[0], "utf-8");
        const session = JSON.parse(data);
        session._filePath = filePaths[0];
        win.webContents.send("loadSession", session);
      }
    });
}

function showHelp() {
  if (helpWin) {
    helpWin.focus();
    return;
  }
  helpWin = new BrowserWindow({
    width: 800,
    height: 700,
    title: "ZX81 Tape Reader — User Guide",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  helpWin.loadFile("help.html");
  helpWin.on("closed", () => {
    helpWin = null;
  });
}

function showAbout() {
  const pkg = require("./package.json");
  dialog.showMessageBox(win, {
    type: "info",
    title: "About ZX81 Tape Reader",
    message: "ZX81 Tape Reader",
    detail: [
      `Version ${pkg.version}`,
      `Author: ${pkg.author}`,
      "",
      "Decode ZX81/TS-2068 tape recordings from WAV files.",
      "",
      "https://github.com/mvindahl/zx81-dat-tape-reader",
    ].join("\n"),
  });
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open WAV...",
          accelerator: "CmdOrCtrl+O",
          click: openWavFile,
        },
        {
          label: "Open Session...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: openSessionFile,
        },
        { type: "separator" },
        {
          label: "Save Session",
          accelerator: "CmdOrCtrl+S",
          click: () => win.webContents.send("menuAction", "saveSession"),
        },
        {
          label: "Save Session As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => win.webContents.send("menuAction", "saveSessionAs"),
        },
        { type: "separator" },
        {
          label: "Export as .p...",
          click: () => win.webContents.send("menuAction", "exportP"),
        },
        {
          label: "Export as .tzx...",
          click: () => win.webContents.send("menuAction", "exportTzx"),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "User Guide",
          accelerator: "F1",
          click: showHelp,
        },
        { type: "separator" },
        {
          label: "About ZX81 Tape Reader",
          click: showAbout,
        },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({ role: "appMenu" });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile("index.html");

  win.webContents.on("did-finish-load", () => {
    if (process.argv[2]) {
      win.webContents.send("inputFile", process.argv[2]);
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle("process-wav-file", (_event, filePath) => {
  const wav = require("node-wav");
  const goertzel = require("goertzel");
  const almostEqual = require("almost-equal");

  const resolvedPath = path.resolve(filePath);
  const buffer = fs.readFileSync(resolvedPath);
  const decodedWav = wav.decode(buffer);
  console.log("samplerate:", decodedWav.sampleRate);
  const samples = decodedWav.channelData[0];
  console.log("total # of samples:", samples.length);

  const samplesPerPulse = (decodedWav.sampleRate * 300) / 1000000;
  console.log("samples per pulse=", samplesPerPulse);

  const targetFrequency = 3200;
  const samplesPerPulseRounded = 2 * Math.round(samplesPerPulse / 2);
  const opts = {
    targetFrequency,
    sampleRate: decodedWav.sampleRate,
    samplesPerFrame: samplesPerPulseRounded,
    threshold: 0.01,
  };
  const detect = goertzel(opts);

  console.log("detecting pulses");

  let detections = [];
  for (var idx = 0; idx < samples.length; idx++) {
    if (
      idx < samplesPerPulseRounded / 2 ||
      idx > samples.length - samplesPerPulseRounded / 2
    ) {
      detections.push(0);
      continue;
    }
    const slice = samples.slice(
      idx - samplesPerPulseRounded / 2,
      idx + samplesPerPulseRounded / 2
    );
    detections.push(detect(slice) ? 1 : 0);
  }

  let runs = [];
  let isUp = false;
  let lastUpIdx;
  let runLengthStats = {};
  for (let idx = 0; idx < detections.length; idx++) {
    if (!isUp && detections[idx] === 1) {
      lastUpIdx = idx;
      isUp = true;
    } else if (isUp && detections[idx] === 0) {
      const runLength = idx - lastUpIdx;
      runs.push({ index: lastUpIdx, runLength: runLength });
      runLengthStats[runLength] = runLengthStats[runLength]
        ? runLengthStats[runLength] + 1
        : 1;
      isUp = false;
    }
  }
  console.log("runLengthStats:");
  for (let i = 0; i < 150; i++) {
    console.log(i, runLengthStats[i] ? runLengthStats[i] : 0);
  }

  const runLengthPad = 15;
  const zeroBitRunLength = Math.floor(4 * samplesPerPulse) + runLengthPad;
  const oneBitRunLength = Math.floor(9 * samplesPerPulse) + runLengthPad;
  const silenceRunLength =
    Math.floor((decodedWav.sampleRate * 1300) / 1000000) - runLengthPad;

  console.log("zero bit run length", zeroBitRunLength);
  console.log("one bit run length", oneBitRunLength);
  console.log("silence periods", silenceRunLength);

  const linesForEdit = runs.map((run) => {
    var bitAsString;
    if (run.runLength < 15) {
      bitAsString = "-";
    } else if (almostEqual(run.runLength, zeroBitRunLength, 0.4)) {
      bitAsString = "0";
    } else if (almostEqual(run.runLength, oneBitRunLength, 0.4)) {
      bitAsString = "1";
    } else {
      bitAsString = "?";
    }
    return bitAsString + "\t" + run.index + ":" + run.runLength;
  });

  var firstBitIdx = linesForEdit.findIndex(
    (val) => val[0] == "0" || val[0] == "1"
  );
  var scanIdx = linesForEdit.findLastIndex(
    (val) => val[0] == "0" || val[0] == "1"
  );
  while (scanIdx > firstBitIdx) {
    var pauseBeforeRun =
      runs[scanIdx].index - (runs[scanIdx - 1].index + runs[scanIdx - 1].runLength);
    if (pauseBeforeRun > 2 * silenceRunLength) {
      linesForEdit[scanIdx - 1] =
        linesForEdit[scanIdx - 1] + " # suspicious loss of signal?";
    }
    scanIdx--;
  }

  return {
    samples: Array.from(samples),
    samplesLength: samples.length,
    runs: runs,
    linesForEdit: linesForEdit,
    zeroBitRunLength: zeroBitRunLength,
    oneBitRunLength: oneBitRunLength,
    silenceRunLength: silenceRunLength,
  };
});

ipcMain.handle("encode-to-tzx", (_event, rawData) => {
  const tzx = require("./tzx");
  return tzx.encode(rawData);
});

ipcMain.handle("save-file", async (_event, dataArray, defaultFileName, fileType) => {
  const filters = {
    tzx: [{ name: "TZX Files", extensions: ["tzx"] }],
    p: [{ name: "ZX81 P Files", extensions: ["p"] }],
  };
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: defaultFileName,
    filters: filters[fileType] || filters.tzx,
  });
  if (filePath) {
    fs.writeFileSync(filePath, Buffer.from(dataArray));
  }
  return filePath;
});

ipcMain.handle("save-session", async (_event, sessionData, filePath) => {
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, {
      filters: [{ name: "ZX81 Tape Reader Session", extensions: ["ztr"] }],
    });
    if (result.canceled) return null;
    filePath = result.filePath;
  }
  fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2));
  return filePath;
});

// --- App lifecycle ---

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
