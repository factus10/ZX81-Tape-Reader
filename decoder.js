// ZX81/TS1000 tape decoder using hysteresis-based half-period detection.
//
// ZX81 tape format encodes bits as pairs of half-periods:
//   1-bit: ~4 short half-periods (~150µs each at standard speed)
//   0-bit: ~8-9 short half-periods
// At 44100 Hz, short half-periods are ~7 samples, long are ~19 samples.
//
// This decoder uses a Schmitt trigger (hysteresis) approach instead of
// zero-crossing detection, which is much more robust against:
//   - Sinusoidal waveforms (azimuth misalignment / head rolloff)
//   - Noise near zero crossings
//   - DC offset drift

const fs = require("fs");
const wav = require("node-wav");

function processWavFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const decodedWav = wav.decode(buffer);
  const sampleRate = decodedWav.sampleRate;
  const rawSamples = decodedWav.channelData[0];
  console.log("samplerate:", sampleRate);
  console.log("total # of samples:", rawSamples.length);

  // --- A. DC offset removal ---
  // Subtract a rolling mean over a ~100ms window
  const dcWindowSize = Math.floor(sampleRate * 0.1);
  const samples = new Float32Array(rawSamples.length);
  let windowSum = 0;
  for (let i = 0; i < Math.min(dcWindowSize, rawSamples.length); i++) {
    windowSum += rawSamples[i];
  }
  for (let i = 0; i < rawSamples.length; i++) {
    const windowStart = Math.max(0, i - Math.floor(dcWindowSize / 2));
    const windowEnd = Math.min(rawSamples.length, windowStart + dcWindowSize);
    // Recompute mean for accuracy (incremental would accumulate drift)
    if (i % 1000 === 0) {
      windowSum = 0;
      for (let j = windowStart; j < windowEnd; j++) {
        windowSum += rawSamples[j];
      }
    }
    const mean = windowSum / (windowEnd - windowStart);
    samples[i] = rawSamples[i] - mean;
  }

  // --- F. Signal start detection ---
  // Scan in 10ms windows for first window where peak > noise floor
  const winSize = Math.floor(sampleRate * 0.01);
  let peakAmplitude = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > peakAmplitude) peakAmplitude = Math.abs(samples[i]);
  }
  const noiseFloor = peakAmplitude * 0.1;
  let signalStart = 0;
  for (let i = 0; i < samples.length - winSize; i += winSize) {
    let maxInWin = 0;
    for (let j = i; j < i + winSize; j++) {
      if (Math.abs(samples[j]) > maxInWin) maxInWin = Math.abs(samples[j]);
    }
    if (maxInWin > noiseFloor) {
      signalStart = i;
      break;
    }
  }
  console.log("signal starts at sample:", signalStart,
    "(" + (signalStart / sampleRate).toFixed(2) + "s)");
  console.log("peak amplitude:", peakAmplitude.toFixed(3));

  // --- B. Hysteresis (Schmitt trigger) transition detection ---
  const hiThresh = peakAmplitude * 0.3;
  const loThresh = -peakAmplitude * 0.3;

  // --- C. Half-period measurement ---
  let state = 0; // 0=low, 1=high
  let lastTransition = signalStart;
  let halfPeriods = []; // {index, length}

  for (let i = signalStart; i < samples.length; i++) {
    if (state === 0 && samples[i] > hiThresh) {
      const hp = i - lastTransition;
      // --- D. Noise gate ---
      if (hp >= 4) {
        halfPeriods.push({ index: lastTransition, length: hp });
      }
      lastTransition = i;
      state = 1;
    } else if (state === 1 && samples[i] < loThresh) {
      const hp = i - lastTransition;
      if (hp >= 4) {
        halfPeriods.push({ index: lastTransition, length: hp });
      }
      lastTransition = i;
      state = 0;
    }
  }

  console.log("total half-periods detected:", halfPeriods.length);

  // --- E. Adaptive threshold ---
  // Build histogram of half-period lengths in the data range (4-30 samples),
  // find the valley between the two peaks (short=1-bit, long=0-bit).
  const hist = new Array(50).fill(0);
  const calibrationCount = Math.min(5000, halfPeriods.length);
  for (let i = 0; i < calibrationCount; i++) {
    const len = halfPeriods[i].length;
    if (len >= 4 && len < 50) hist[len]++;
  }

  // Find the minimum count in the range between the two peaks
  // First, find the short-pulse peak (should be in 4-12 range)
  let shortPeak = 4;
  for (let i = 4; i <= 12; i++) {
    if (hist[i] > hist[shortPeak]) shortPeak = i;
  }
  // Then find the long-pulse peak (should be in 14-30 range)
  let longPeak = 14;
  for (let i = 14; i <= 30; i++) {
    if (hist[i] > hist[longPeak]) longPeak = i;
  }
  // Find the valley between them
  let threshold = Math.floor((shortPeak + longPeak) / 2); // fallback: midpoint
  let minCount = Infinity;
  for (let i = shortPeak + 1; i < longPeak; i++) {
    if (hist[i] < minCount) {
      minCount = hist[i];
      threshold = i;
    }
  }
  // Use midpoint of the valley region for robustness
  threshold += 0.5;

  console.log("adaptive threshold:", threshold.toFixed(1), "samples");
  console.log("  short peak at:", shortPeak, "  long peak at:", longPeak);

  // --- G. Bit classification ---
  // ZX81 tape format: each bit is a burst of short half-periods (carrier pulses)
  // separated by gaps (long half-periods or silence).
  //   1-bit: ~4 short half-periods (fewer pulses)
  //   0-bit: ~9 short half-periods (more pulses)
  //
  // The long half-periods between bursts are inter-bit gaps, not data.
  // Strategy: group consecutive short HPs into bursts, then classify by count.

  // Group short half-periods into bursts separated by non-short HPs
  let bursts = [];
  let burstStart = -1;
  let burstSampleStart = 0;
  let burstHPs = 0;
  let burstSampleEnd = 0;

  for (let j = 0; j < halfPeriods.length; j++) {
    const hp = halfPeriods[j];
    const isShort = hp.length >= 4 && hp.length <= threshold;

    if (isShort) {
      if (burstStart === -1) {
        burstStart = j;
        burstSampleStart = hp.index;
        burstHPs = 1;
      } else {
        burstHPs++;
      }
      burstSampleEnd = hp.index + hp.length;
    } else {
      if (burstStart !== -1) {
        bursts.push({
          index: burstSampleStart,
          runLength: burstSampleEnd - burstSampleStart,
          halfPeriodCount: burstHPs,
        });
        burstStart = -1;
        burstHPs = 0;
      }
      // Track non-data (sync/pilot) for display
      if (hp.length > 40) {
        bursts.push({
          index: hp.index,
          runLength: hp.length,
          halfPeriodCount: 0,
          isSync: true,
        });
      }
    }
  }
  if (burstStart !== -1) {
    bursts.push({
      index: burstSampleStart,
      runLength: burstSampleEnd - burstSampleStart,
      halfPeriodCount: burstHPs,
    });
  }

  // Find the threshold between 1-bit HP counts and 0-bit HP counts
  // using histogram of burst sizes
  const burstHist = new Array(30).fill(0);
  for (const b of bursts) {
    if (!b.isSync && b.halfPeriodCount >= 2 && b.halfPeriodCount < 30) {
      burstHist[b.halfPeriodCount]++;
    }
  }

  console.log("burst size histogram:");
  for (let k = 2; k < 20; k++) {
    if (burstHist[k] > 0)
      console.log("  " + k + " HPs: " + burstHist[k]);
  }

  // Find the valley between the two clusters
  // First peak should be around 2-4 (1-bits), second around 5-9 (0-bits)
  let peak1 = 2, peak2 = 6;
  for (let k = 2; k <= 5; k++) {
    if (burstHist[k] > burstHist[peak1]) peak1 = k;
  }
  for (let k = 5; k <= 12; k++) {
    if (burstHist[k] > burstHist[peak2]) peak2 = k;
  }

  let bitThreshold = Math.floor((peak1 + peak2) / 2) + 0.5;
  // Find actual valley
  let minVal = Infinity;
  for (let k = peak1 + 1; k < peak2; k++) {
    if (burstHist[k] < minVal) {
      minVal = burstHist[k];
      bitThreshold = k + 0.5;
    }
  }

  console.log("bit threshold:", bitThreshold, "HPs (peak1=" + peak1 + ", peak2=" + peak2 + ")");

  const runs = bursts;

  // Approximate run lengths for waveform display
  const oneBitRunLength = Math.round(shortPeak * 2 * peak1);
  const zeroBitRunLength = Math.round(shortPeak * 2 * peak2);
  const silenceRunLength = Math.round(longPeak * 2);

  console.log("one bit run length:", oneBitRunLength);
  console.log("zero bit run length:", zeroBitRunLength);

  // Build editor lines
  const linesForEdit = runs.map((run) => {
    let bitAsString;
    if (run.isSync) {
      bitAsString = "-";
    } else if (run.halfPeriodCount < 2) {
      bitAsString = "-";
    } else if (run.halfPeriodCount <= bitThreshold) {
      bitAsString = "1";
    } else {
      bitAsString = "0";
    }
    return bitAsString + "\t" + run.index + ":" + run.runLength;
  });

  // Mark suspicious gaps
  const firstBitIdx = linesForEdit.findIndex(
    (val) => val[0] === "0" || val[0] === "1"
  );
  let scanIdx = linesForEdit.findLastIndex(
    (val) => val[0] === "0" || val[0] === "1"
  );
  while (scanIdx > firstBitIdx) {
    const gapBetween =
      runs[scanIdx].index -
      (runs[scanIdx - 1].index + runs[scanIdx - 1].runLength);
    if (gapBetween > silenceRunLength * 4) {
      linesForEdit[scanIdx - 1] =
        linesForEdit[scanIdx - 1] + " # suspicious loss of signal?";
    }
    scanIdx--;
  }

  // Stats
  const ones = linesForEdit.filter((l) => l[0] === "1").length;
  const zeros = linesForEdit.filter((l) => l[0] === "0").length;
  const unknowns = linesForEdit.filter((l) => l[0] === "?").length;
  console.log("decoded:", ones, "ones,", zeros, "zeros,", unknowns, "unknowns");
  console.log("total bits:", ones + zeros);
  console.log("total bytes:", Math.floor((ones + zeros) / 8));

  return {
    samples: Array.from(rawSamples),
    samplesLength: rawSamples.length,
    runs: runs,
    linesForEdit: linesForEdit,
    zeroBitRunLength: zeroBitRunLength,
    oneBitRunLength: oneBitRunLength,
    silenceRunLength: silenceRunLength,
  };
}

module.exports = { processWavFile };
