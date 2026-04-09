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

// Zoom: samplesPerPixel controls how many samples each pixel represents.
// zoom slider 0..100 maps exponentially: 0=32x zoom out, 50=1x, 100=0.125x (8x zoom in)
let samplesPerPixel = 1;

function zoomSliderToSPP(val) {
  // exponential: slider 50 = 1 spp, 0 = 32 spp, 100 = 1/8 spp
  return Math.pow(2, (50 - val) / 10);
}

function sppToZoomSlider(spp) {
  return 50 - Math.log2(spp) * 10;
}

function zoomLabel(spp) {
  if (spp >= 1) return (1 / spp).toFixed(spp >= 4 ? 2 : 1) + "x";
  return Math.round(1 / spp) + "x";
}

function clampOffset() {
  if (samples) {
    const visibleSamples = canvasWidth * samplesPerPixel;
    canvasOffset = Math.max(
      0,
      Math.min(canvasOffset, samplesLength - visibleSamples)
    );
  }
}

function updatePositionSlider() {
  if (!samples) return;
  const slider = document.getElementById("PositionSlider");
  const visibleSamples = canvasWidth * samplesPerPixel;
  const maxOffset = Math.max(0, samplesLength - visibleSamples);
  slider.value = maxOffset > 0 ? (canvasOffset / maxOffset) * 1000 : 0;
}

const zoomSlider = document.getElementById("ZoomSlider");
const positionSlider = document.getElementById("PositionSlider");

zoomSlider.addEventListener("input", (e) => {
  const centerSample = canvasOffset + (canvasWidth * samplesPerPixel) / 2;
  samplesPerPixel = zoomSliderToSPP(Number(e.target.value));
  document.getElementById("ZoomLabel").textContent = zoomLabel(samplesPerPixel);
  canvasOffset = centerSample - (canvasWidth * samplesPerPixel) / 2;
  clampOffset();
  manualScroll = true;
  repaintCanvas();
  manualScroll = false;
});

positionSlider.addEventListener("input", (e) => {
  if (!samples) return;
  const visibleSamples = canvasWidth * samplesPerPixel;
  const maxOffset = Math.max(0, samplesLength - visibleSamples);
  canvasOffset = (Number(e.target.value) / 1000) * maxOffset;
  clampOffset();
  manualScroll = true;
  repaintCanvas();
  manualScroll = false;
});

document.getElementById("Canvas").addEventListener("click", (e) => {
  const sampleIdx = Math.floor(canvasOffset + e.offsetX * samplesPerPixel);
  let bestRow = 0;
  let bestDist = Infinity;
  let runDataCache = {};
  for (let row = 0; row < editor.session.getLength(); row++) {
    const rd = getRunData(row, runDataCache);
    if (rd && (rd.bitValue === "0" || rd.bitValue === "1" || rd.bitValue === "?")) {
      const center = rd.offset + rd.length / 2;
      const dist = Math.abs(center - sampleIdx);
      if (dist < bestDist) {
        bestDist = dist;
        bestRow = row;
      }
    }
  }
  editor.gotoLine(bestRow + 1, 0, true);
  editor.focus();
});

document.getElementById("Canvas").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + scroll = zoom
      const centerSample = canvasOffset + (canvasWidth * samplesPerPixel) / 2;
      const zoomDelta = e.deltaY > 0 ? 5 : -5;
      const newVal = Math.max(0, Math.min(100, Number(zoomSlider.value) - zoomDelta));
      zoomSlider.value = newVal;
      samplesPerPixel = zoomSliderToSPP(newVal);
      document.getElementById("ZoomLabel").textContent = zoomLabel(samplesPerPixel);
      canvasOffset = centerSample - (canvasWidth * samplesPerPixel) / 2;
    } else {
      // Regular scroll = pan
      const scrollAmount = e.deltaX || e.deltaY;
      canvasOffset += Math.round(scrollAmount * 3 * samplesPerPixel);
    }
    clampOffset();
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

  const visibleSamples = canvasWidth * samplesPerPixel;

  let runDataCache = {};
  const cursorRow = editor.getSelection().getCursor().row;
  const currentLineRunData = getRunData(cursorRow, runDataCache);

  if (currentLineRunData && !manualScroll) {
    canvasOffset = Math.floor(
      currentLineRunData.offset +
        currentLineRunData.length / 2 -
        visibleSamples / 2
    );
    clampOffset();
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
    ctx.beginPath();
    for (let px = 0; px < canvasWidth; px++) {
      const sampleIdx = Math.floor(canvasOffset + px * samplesPerPixel);
      if (sampleIdx >= 0 && sampleIdx < samplesLength) {
        ctx.moveTo(px, 50);
        ctx.lineTo(px, 50 - 50 * samples[sampleIdx]);
      }
    }
    ctx.stroke();
  }

  ctx.font = "10px Lucida Console";
  ctx.fillStyle = "#aaa";
  ctx.fillRect(0, 0, 120, 12);
  ctx.fillStyle = "white";
  ctx.fillText("offset: " + Math.floor(canvasOffset) + "  " + zoomLabel(samplesPerPixel), 4, 10);

  updatePositionSlider();

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

    const x = (runData.offset - canvasOffset) / samplesPerPixel;
    const w = runData.length / samplesPerPixel;

    if (x + w < 0) {
      return false;
    }
    if (x > canvasWidth) {
      return false;
    }

    ctx.fillRect(x, 100, Math.max(w, 1), 20);

    if (w > 10) {
      ctx.font = "20px Georgia";
      ctx.fillStyle = "black";
      ctx.fillText(runData.bitValue, Math.floor(x + w / 2) - 5, 136);
    }
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
