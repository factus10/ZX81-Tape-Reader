console.log("app.js loaded");

window.editor = ace.edit("editor");
editor.setTheme("ace/theme/monokai");
editor.getSession().setMode("ace/mode/properties");

let samples;
let samplesLength;
let zeroBitRunLength;
let oneBitRunLength;
let silenceRunLength;
let fileName;
let currentSessionPath = null;

function setupEditorListeners() {
  editor.getSession().on("change", function () {
    repaintCanvas();
  });

  editor.getSession().selection.on("changeCursor", function () {
    repaintCanvas();
  });

  editor.getSession().selection.on("changeSelection", function () {
    repaintCanvas();
  });
}

let listenersAttached = false;

window.electronAPI.onInputFile(async (inputFile) => {
  if (!inputFile) return;
  console.log(inputFile);
  fileName = inputFile;
  currentSessionPath = null;

  const result = await window.electronAPI.processWavFile(inputFile);

  samples = new Float32Array(result.samples);
  samplesLength = result.samplesLength;
  zeroBitRunLength = result.zeroBitRunLength;
  oneBitRunLength = result.oneBitRunLength;
  silenceRunLength = result.silenceRunLength;

  document.title = "ZX81 Tape Reader — " + fileName;

  editor.setValue(result.linesForEdit.join("\n"), -1);

  if (!listenersAttached) {
    setupEditorListeners();
    listenersAttached = true;
  }

  repaintCanvas();
});

window.electronAPI.onLoadSession((session) => {
  console.log("Loading session:", session._filePath);
  currentSessionPath = session._filePath;
  fileName = session.wavPath;
  zeroBitRunLength = session.zeroBitRunLength;
  oneBitRunLength = session.oneBitRunLength;
  silenceRunLength = session.silenceRunLength;
  samples = null;
  samplesLength = 0;

  document.title = "ZX81 Tape Reader — " + currentSessionPath;

  editor.setValue(session.editorContent, -1);

  if (!listenersAttached) {
    setupEditorListeners();
    listenersAttached = true;
  }

  repaintCanvas();
});

window.electronAPI.onMenuAction((action) => {
  switch (action) {
    case "saveSession":
      saveSession();
      break;
    case "saveSessionAs":
      saveSessionAs();
      break;
    case "exportP":
      exportDataAsP();
      break;
    case "exportTzx":
      exportData();
      break;
  }
});

// --- Session save/load ---

async function saveSession() {
  const sessionData = {
    version: 1,
    wavPath: fileName || "",
    editorContent: editor.getValue(),
    zeroBitRunLength: zeroBitRunLength,
    oneBitRunLength: oneBitRunLength,
    silenceRunLength: silenceRunLength,
  };
  const savedPath = await window.electronAPI.saveSession(
    sessionData,
    currentSessionPath
  );
  if (savedPath) {
    currentSessionPath = savedPath;
    document.title = "ZX81 Tape Reader — " + currentSessionPath;
  }
}

async function saveSessionAs() {
  const sessionData = {
    version: 1,
    wavPath: fileName || "",
    editorContent: editor.getValue(),
    zeroBitRunLength: zeroBitRunLength,
    oneBitRunLength: oneBitRunLength,
    silenceRunLength: silenceRunLength,
  };
  const savedPath = await window.electronAPI.saveSession(sessionData, null);
  if (savedPath) {
    currentSessionPath = savedPath;
    document.title = "ZX81 Tape Reader — " + currentSessionPath;
  }
}

// --- Canvas ---

let canvasOffset = 0;
let canvasWidth;
let manualScroll = false;

document.getElementById("Canvas").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const scrollAmount = e.deltaX || e.deltaY;
    canvasOffset += Math.round(scrollAmount * 3);
    if (samples) {
      canvasOffset = Math.max(
        0,
        Math.min(canvasOffset, samplesLength - canvasWidth)
      );
    }
    manualScroll = true;
    repaintCanvas();
    manualScroll = false;
  },
  { passive: false }
);

function repaintCanvas() {
  const canvas = document.getElementById("Canvas");
  canvasWidth = window.innerWidth;
  canvas.width = canvasWidth;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let runDataCache = {};
  const cursorRow = editor.getSelection().getCursor().row;
  const currentLineRunData = getRunData(cursorRow, runDataCache);

  if (currentLineRunData && !manualScroll) {
    canvasOffset = Math.floor(
      currentLineRunData.offset +
        currentLineRunData.length / 2 -
        canvasWidth / 2
    );
    canvasOffset = Math.max(canvasOffset, 0);
    if (samples) {
      canvasOffset = Math.min(canvasOffset, samplesLength - canvasWidth);
    }
  }

  let row = cursorRow;
  while (row >= 0) {
    const inBounds = paintRun(
      ctx,
      getRunData(row, runDataCache),
      row === cursorRow
    );
    if (!inBounds) {
      break;
    }
    row--;
  }

  row = cursorRow + 1;
  while (row < editor.session.getLength()) {
    var inBounds = paintRun(
      ctx,
      getRunData(row, runDataCache),
      row === cursorRow
    );
    if (!inBounds) {
      break;
    }
    row++;
  }

  if (samples) {
    for (let idx = 0; idx < canvasWidth; idx++) {
      ctx.moveTo(idx, 50);
      ctx.lineTo(idx, 50 - 50 * samples[idx + canvasOffset]);
    }
    ctx.stroke();
  }

  ctx.font = "10px Lucida Console";
  ctx.fillStyle = "#aaa";
  ctx.fillRect(0, 0, 80, 12);
  ctx.fillStyle = "white";
  ctx.fillText("offset: " + canvasOffset, 4, 10);

  const bitlen = getBits().length;

  const bytelen = Math.floor(bitlen / 8);
  const remainingBitlen = bitlen % 8;

  document.getElementById("ByteLen").innerHTML =
    bytelen + " byte" + (bytelen !== 1 ? "s" : "");
  document.getElementById("BitLen").style.visibility =
    remainingBitlen === 0 ? "hidden" : "visible";
  document.getElementById("BitLen").innerHTML =
    " and " + remainingBitlen + " bit" + (remainingBitlen !== 1 ? "s" : "");
}

// --- Editor helpers ---

function parseLine(str) {
  str = str.split("#")[0];
  const editorLineRegex = /^(.)\s*(\d*)?(?::(\d*))?\s*$/;
  return editorLineRegex.exec(str);
}

function getRunData(rowNumber, runDataCache) {
  if (runDataCache[rowNumber]) {
    return runDataCache[rowNumber];
  }

  const match = parseLine(editor.session.getLine(rowNumber));
  if (match) {
    const bitValue = match[1];

    let offset = parseInt(match[2]);
    if (!offset) {
      if (rowNumber === 0) {
        offset = 0;
      } else {
        let prevRowRunData;
        let searchBackIdx = rowNumber - 1;
        while (searchBackIdx >= 0 && !prevRowRunData) {
          prevRowRunData = getRunData(searchBackIdx--, runDataCache);
        }

        if (prevRowRunData) {
          offset =
            prevRowRunData.offset + prevRowRunData.length + silenceRunLength;
        } else {
          offset = 0;
        }
      }
    }

    let length;
    if (match[3] && match[3] !== "") {
      length = parseInt(match[3]);
    } else if (bitValue === "0") {
      length = zeroBitRunLength;
    } else if (bitValue === "1") {
      length = oneBitRunLength;
    } else {
      length = 0;
    }

    const result = {
      bitValue: bitValue,
      offset: offset,
      length: length,
    };
    runDataCache[rowNumber] = result;
    return result;
  }
}

function paintRun(ctx, runData, isCursorRow) {
  if (runData) {
    if (isCursorRow) {
      ctx.fillStyle = "blue";
    } else {
      ctx.fillStyle = "#444";
    }

    if (runData.offset - canvasOffset + runData.length < 0) {
      return false;
    }
    if (runData.offset - canvasOffset > canvasWidth) {
      return false;
    }

    ctx.fillRect(runData.offset - canvasOffset, 100, runData.length, 20);

    ctx.font = "20px Georgia";
    ctx.fillStyle = "black";

    ctx.fillText(
      runData.bitValue,
      Math.floor(runData.offset - canvasOffset + runData.length / 2) - 5,
      136
    );
  }
  return true;
}

function getBits() {
  const editorLines = editor.getValue().split("\n");

  let bits = [];
  for (let idx = 0; idx < editorLines.length; idx++) {
    const editorLine = editorLines[idx];
    const match = parseLine(editorLine);
    if (match) {
      const bitValue = match[1];
      if (bitValue === "0" || bitValue === "1") {
        bits.push(bitValue);
      }
    }
  }

  return bits;
}

// --- Export ---

function getRawData() {
  const bits = getBits();
  var bitString = bits.join("");
  let rawData = [];
  while (bitString.length > 0) {
    let bitsForByte = bitString.slice(0, 8);
    let value = 0;
    for (var pos = 0; pos < 8; pos++) {
      value *= 2;
      if (bitsForByte.charAt(pos) === "1") {
        value++;
      }
    }
    rawData.push(value);
    bitString = bitString.slice(8);
  }
  return rawData;
}

async function exportData() {
  const rawData = getRawData();
  const tzxEncodedBytes = await window.electronAPI.encodeToTzx(rawData);
  const outputFileName = (fileName || "untitled") + ".tzx";
  await window.electronAPI.saveFile(tzxEncodedBytes, outputFileName, "tzx");
}

async function exportDataAsP() {
  const rawData = getRawData();
  const outputFileName =
    (fileName || "untitled").replace(/\.wav$/i, "") + ".p";
  await window.electronAPI.saveFile(rawData, outputFileName, "p");
}
