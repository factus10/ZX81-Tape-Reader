// ZX81/TS1000 tape decoder with swappable detection methods.
//
// ZX81 tape format encodes bits as bursts of carrier pulses (~3250 Hz):
//   0-bit: 4 carrier pulses (fewer)
//   1-bit: 9 carrier pulses (more)
//
// Detection methods:
//   "peak" (default): one-sided — counts only positive-going threshold
//     crossings in the cleaner half of the signal. Ignores capacitor-
//     discharge noise on the opposite half. Best for typical/clean tapes.
//   "edge": zero-crossing — counts all sign changes (with amplitude
//     filtering and noise-interval absorption). Better for degraded/weak
//     signals where every transition counts.
//
// Pre-decode conditioning (both methods):
//   volume     — gain multiplier applied before detection
//   bias       — DC offset added after gain
//   polarity   — "pos" or "neg" (flip signal before detection)
//   threshold  — detection level as fraction of local peak (peak method)

const fs = require("fs");
const wav = require("node-wav");

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

function processWavFile(filePath, options) {
  const loaded = loadWav(filePath);
  return decodeSamples(loaded.samples, loaded.sampleRate, options);
}

function loadWav(filePath) {
  const buffer = fs.readFileSync(filePath);
  const decoded = wav.decode(buffer);
  return {
    samples: decoded.channelData[0],
    sampleRate: decoded.sampleRate,
  };
}

function decodeSamples(rawSamples, sampleRate, options) {
  const opts = {
    method: "peak",      // "peak" | "edge"
    volume: 1.0,         // gain multiplier
    bias: 0.0,           // DC offset (-1.0 .. +1.0 scale)
    polarity: "pos",     // "pos" | "neg"
    threshold: 0.5,      // peak method: detection level as fraction of local peak
    ...(options || {}),
  };

  console.log("samplerate:", sampleRate);
  console.log("total # of samples:", rawSamples.length);
  console.log("method:", opts.method, "volume:", opts.volume, "bias:", opts.bias,
              "polarity:", opts.polarity, "threshold:", opts.threshold);

  // DC offset removal (rolling mean)
  const dcRemoved = removeDcOffset(rawSamples, sampleRate);

  // Apply conditioning: volume, bias, polarity
  const conditioned = applyConditioning(dcRemoved, opts);

  // Compute peak amplitude (after conditioning) and signal start
  let peakAmplitude = 0;
  for (let i = 0; i < conditioned.length; i++) {
    const a = Math.abs(conditioned[i]);
    if (a > peakAmplitude) peakAmplitude = a;
  }

  const signalStart = findSignalStart(conditioned, sampleRate, peakAmplitude);
  console.log("signal starts at sample:", signalStart,
    "(" + (signalStart / sampleRate).toFixed(2) + "s)");
  console.log("peak amplitude:", peakAmplitude.toFixed(3));

  // Local peak cache for amplitude-aware detection
  const peakCache = buildPeakCache(conditioned);

  // Detect transitions using the selected method
  let result;
  if (opts.method === "peak") {
    result = decodePeakMethod(conditioned, signalStart, peakCache, opts);
  } else {
    result = decodeEdgeMethod(conditioned, signalStart, peakCache, opts);
  }

  // Build editor lines and statistics
  const { runs, zeroBitRunLength, oneBitRunLength, silenceRunLength } = result;
  const { linesForEdit } = buildLinesForEdit(runs, result.bitThreshold, silenceRunLength);

  const ones = linesForEdit.filter((l) => l[0] === "1").length;
  const zeros = linesForEdit.filter((l) => l[0] === "0").length;
  console.log("decoded:", ones, "ones,", zeros, "zeros");
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
    // Reflect the options actually used (for UI state):
    options: opts,
    peakAmplitude: peakAmplitude,
  };
}

// ---------------------------------------------------------------------------
// Pre-processing
// ---------------------------------------------------------------------------

function removeDcOffset(rawSamples, sampleRate) {
  // 100ms rolling mean subtraction; mean recomputed every 1000 samples
  // for accuracy (incremental would accumulate drift).
  const dcWindowSize = Math.floor(sampleRate * 0.1);
  const out = new Float32Array(rawSamples.length);
  let windowSum = 0;
  for (let i = 0; i < Math.min(dcWindowSize, rawSamples.length); i++) {
    windowSum += rawSamples[i];
  }
  for (let i = 0; i < rawSamples.length; i++) {
    const windowStart = Math.max(0, i - Math.floor(dcWindowSize / 2));
    const windowEnd = Math.min(rawSamples.length, windowStart + dcWindowSize);
    if (i % 1000 === 0) {
      windowSum = 0;
      for (let j = windowStart; j < windowEnd; j++) windowSum += rawSamples[j];
    }
    const mean = windowSum / (windowEnd - windowStart);
    out[i] = rawSamples[i] - mean;
  }
  return out;
}

function applyConditioning(samples, opts) {
  // Apply volume (gain), bias (DC shift), and polarity (sign flip) in that order.
  const v = opts.volume;
  const b = opts.bias;
  const flip = opts.polarity === "neg" ? -1 : 1;
  if (v === 1.0 && b === 0.0 && flip === 1) return samples; // no-op
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = flip * (samples[i] * v + b);
  }
  return out;
}

function findSignalStart(samples, sampleRate, peakAmplitude) {
  // Require 30ms of sustained signal above 25% peak to avoid triggering on noise.
  const winSize = Math.floor(sampleRate * 0.01);
  const threshold = peakAmplitude * 0.25;
  const required = 3;
  let consecutive = 0;
  for (let i = 0; i < samples.length - winSize; i += winSize) {
    let maxInWin = 0;
    for (let j = i; j < i + winSize; j++) {
      const a = Math.abs(samples[j]);
      if (a > maxInWin) maxInWin = a;
    }
    if (maxInWin > threshold) {
      consecutive++;
      if (consecutive >= required) return i - (required - 1) * winSize;
    } else {
      consecutive = 0;
    }
  }
  return 0;
}

function buildPeakCache(samples) {
  // Cache local peak amplitude in ~11ms windows for performance.
  const step = 100;
  const halfWindow = 250;
  const cache = new Float32Array(Math.ceil(samples.length / step));
  for (let i = 0; i < cache.length; i++) {
    const start = Math.max(0, i * step - halfWindow);
    const end = Math.min(samples.length, i * step + step + halfWindow);
    let mx = 0;
    for (let j = start; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > mx) mx = a;
    }
    cache[i] = mx;
  }
  return cache;
}

function localPeakAt(peakCache, sampleIdx) {
  const step = 100;
  const ci = Math.min(Math.floor(sampleIdx / step), peakCache.length - 1);
  return peakCache[ci];
}

// ---------------------------------------------------------------------------
// Method: Peak (one-sided positive threshold crossing)
// ---------------------------------------------------------------------------

function decodePeakMethod(samples, signalStart, peakCache, opts) {
  const thresholdFrac = opts.threshold;
  const hysteresisFrac = Math.min(thresholdFrac * 0.3, 0.15);

  // Find positive-going threshold crossings with Schmitt-trigger hysteresis.
  // Each ZX81 carrier pulse produces exactly one such crossing.
  const crossings = [];
  let state = false;
  for (let i = signalStart; i < samples.length; i++) {
    const localPeak = Math.max(localPeakAt(peakCache, i), 0.01);
    const hi = localPeak * thresholdFrac;
    const lo = localPeak * hysteresisFrac;
    if (!state && samples[i] > hi) {
      crossings.push(i);
      state = true;
    } else if (state && samples[i] < lo) {
      state = false;
    }
  }
  console.log("total peak crossings:", crossings.length);

  // Intervals between successive crossings
  const intervals = [];
  for (let i = 1; i < crossings.length; i++) {
    intervals.push({
      index: crossings[i - 1],
      length: crossings[i] - crossings[i - 1],
    });
  }

  // Histogram: find the carrier period (should be ~14 samples at 44.1kHz)
  const hist = new Array(120).fill(0);
  const calib = Math.min(20000, intervals.length);
  for (let i = 0; i < calib; i++) {
    const l = intervals[i].length;
    if (l >= 5 && l < 120) hist[l]++;
  }
  let carrierPeriod = 14;
  for (let i = 8; i <= 20; i++) if (hist[i] > hist[carrierPeriod]) carrierPeriod = i;

  // Max carrier interval: valley after the peak
  let carrierMax = carrierPeriod + 4;
  let minCount = Infinity;
  for (let i = carrierPeriod + 1; i <= carrierPeriod + 15; i++) {
    if (i < 120 && hist[i] < minCount) {
      minCount = hist[i];
      carrierMax = i;
    }
  }
  const carrierMin = Math.max(5, Math.floor(carrierPeriod * 0.5));

  console.log("carrier period:", carrierPeriod, "samples (range " + carrierMin + "-" + carrierMax + ")");

  // Group consecutive carrier-period intervals into bursts.
  // A burst with N intervals = N+1 pulses.
  const bursts = [];
  let bStart = -1, bSampStart = 0, bInt = 0, bSampEnd = 0;
  for (let j = 0; j < intervals.length; j++) {
    const iv = intervals[j];
    const isCarrier = iv.length >= carrierMin && iv.length <= carrierMax;
    if (isCarrier) {
      if (bStart === -1) {
        bStart = j; bSampStart = iv.index; bInt = 1;
      } else {
        bInt++;
      }
      bSampEnd = iv.index + iv.length;
    } else {
      if (bStart !== -1 && bInt >= 2) {
        bursts.push({
          index: bSampStart,
          runLength: bSampEnd - bSampStart,
          halfPeriodCount: bInt + 1,   // interpreted as pulses for peak method
        });
      }
      bStart = -1; bInt = 0;
      if (iv.length > carrierMax * 4) {
        bursts.push({
          index: iv.index,
          runLength: iv.length,
          halfPeriodCount: 0,
          isSync: true,
        });
      }
    }
  }
  if (bStart !== -1 && bInt >= 2) {
    bursts.push({
      index: bSampStart,
      runLength: bSampEnd - bSampStart,
      halfPeriodCount: bInt + 1,
    });
  }

  // Find 0-bit and 1-bit peaks in burst pulse histogram
  const burstHist = new Array(30).fill(0);
  for (const b of bursts) {
    if (!b.isSync && b.halfPeriodCount >= 2 && b.halfPeriodCount < 30) {
      burstHist[b.halfPeriodCount]++;
    }
  }

  console.log("burst pulse histogram:");
  for (let k = 2; k < 20; k++) {
    if (burstHist[k] > 0) console.log("  " + k + " pulses: " + burstHist[k]);
  }

  let peak0 = 4, peak1 = 9;
  for (let k = 3; k <= 6; k++) if (burstHist[k] > burstHist[peak0]) peak0 = k;
  for (let k = 7; k <= 12; k++) if (burstHist[k] > burstHist[peak1]) peak1 = k;

  let bitThreshold = Math.floor((peak0 + peak1) / 2) + 0.5;
  let minVal = Infinity;
  for (let k = peak0 + 1; k < peak1; k++) {
    if (burstHist[k] < minVal) { minVal = burstHist[k]; bitThreshold = k + 0.5; }
  }

  console.log("bit threshold:", bitThreshold, "pulses (0-bit peak=" + peak0 + ", 1-bit peak=" + peak1 + ")");

  return {
    runs: bursts,
    bitThreshold,
    zeroBitRunLength: Math.round(carrierPeriod * peak0),
    oneBitRunLength: Math.round(carrierPeriod * peak1),
    silenceRunLength: Math.round(carrierMax * 4),
  };
}

// ---------------------------------------------------------------------------
// Method: Edge (zero-crossing with amplitude filter and noise absorption)
// ---------------------------------------------------------------------------

function decodeEdgeMethod(samples, signalStart, peakCache, opts) {
  // Amplitude-filtered zero-crossing detection.
  const minAmpFraction = 0.1;
  const crossings = [];
  let lastSign = samples[signalStart] > 0 ? 1 : -1;
  let maxSinceLast = 0;
  for (let i = signalStart + 1; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > maxSinceLast) maxSinceLast = a;
    const sign = samples[i] > 0 ? 1 : -1;
    if (sign !== lastSign) {
      const localPeak = localPeakAt(peakCache, i);
      if (maxSinceLast > localPeak * minAmpFraction) {
        crossings.push(i);
        maxSinceLast = 0;
      }
      lastSign = sign;
    }
  }
  console.log("total zero crossings:", crossings.length);

  // Raw intervals
  const rawIntervals = [];
  for (let i = 1; i < crossings.length; i++) {
    rawIntervals.push({
      index: crossings[i - 1],
      length: crossings[i] - crossings[i - 1],
    });
  }

  // Noise interval absorption: combine sub-3-sample intervals with neighbors
  // (handles clipped signals with noise on the flat tops).
  const minCarrierInterval = 3;
  const intervals = [];
  let ii = 0;
  while (ii < rawIntervals.length) {
    const cur = rawIntervals[ii];
    if (cur.length < minCarrierInterval && ii + 1 < rawIntervals.length && intervals.length > 0) {
      const next = rawIntervals[ii + 1];
      const prev = intervals[intervals.length - 1];
      prev.length = (next.index + next.length) - prev.index;
      ii += 2;
    } else if (cur.length < minCarrierInterval && intervals.length > 0) {
      const prev = intervals[intervals.length - 1];
      prev.length = (cur.index + cur.length) - prev.index;
      ii++;
    } else {
      intervals.push({ index: cur.index, length: cur.length });
      ii++;
    }
  }

  // Interval histogram and carrier threshold
  const hist = new Array(80).fill(0);
  const calib = Math.min(20000, intervals.length);
  for (let i = 0; i < calib; i++) {
    const l = intervals[i].length;
    if (l >= 3 && l < 80) hist[l]++;
  }
  let carrierPeak = 4;
  for (let i = 4; i <= 12; i++) if (hist[i] > hist[carrierPeak]) carrierPeak = i;
  let carrierMax = carrierPeak + 3;
  let minCount = Infinity;
  for (let i = carrierPeak + 1; i <= carrierPeak + 8; i++) {
    if (i < 80 && hist[i] < minCount) { minCount = hist[i]; carrierMax = i; }
  }
  console.log("carrier peak at:", carrierPeak, "samples; max threshold:", carrierMax);

  // Burst grouping
  const bursts = [];
  let bStart = -1, bSampStart = 0, bInt = 0, bSampEnd = 0;
  for (let j = 0; j < intervals.length; j++) {
    const iv = intervals[j];
    const isCarrier = iv.length >= 3 && iv.length <= carrierMax;
    if (isCarrier) {
      if (bStart === -1) { bStart = j; bSampStart = iv.index; bInt = 1; }
      else bInt++;
      bSampEnd = iv.index + iv.length;
    } else {
      if (bStart !== -1 && bInt >= 3) {
        const cycles = Math.round((bInt + 1) / 2);
        bursts.push({
          index: bSampStart,
          runLength: bSampEnd - bSampStart,
          halfPeriodCount: cycles,
        });
      }
      bStart = -1; bInt = 0;
      if (iv.length > carrierMax * 4) {
        bursts.push({
          index: iv.index,
          runLength: iv.length,
          halfPeriodCount: 0,
          isSync: true,
        });
      }
    }
  }
  if (bStart !== -1 && bInt >= 3) {
    const cycles = Math.round((bInt + 1) / 2);
    bursts.push({
      index: bSampStart,
      runLength: bSampEnd - bSampStart,
      halfPeriodCount: cycles,
    });
  }

  // Burst cycle histogram → 0-bit vs 1-bit peaks
  const burstHist = new Array(30).fill(0);
  for (const b of bursts) {
    if (!b.isSync && b.halfPeriodCount >= 2 && b.halfPeriodCount < 30) {
      burstHist[b.halfPeriodCount]++;
    }
  }
  console.log("burst cycle histogram:");
  for (let k = 2; k < 20; k++) {
    if (burstHist[k] > 0) console.log("  " + k + " cycles: " + burstHist[k]);
  }

  let peak0 = 3, peak1 = 8;
  for (let k = 3; k <= 7; k++) if (burstHist[k] > burstHist[peak0]) peak0 = k;
  for (let k = 7; k <= 15; k++) if (burstHist[k] > burstHist[peak1]) peak1 = k;
  let bitThreshold = Math.floor((peak0 + peak1) / 2) + 0.5;
  let minVal = Infinity;
  for (let k = peak0 + 1; k < peak1; k++) {
    if (burstHist[k] < minVal) { minVal = burstHist[k]; bitThreshold = k + 0.5; }
  }
  console.log("bit threshold:", bitThreshold, "cycles (0-bit peak=" + peak0 + ", 1-bit peak=" + peak1 + ")");

  const carrierPeriod = carrierPeak * 2;
  return {
    runs: bursts,
    bitThreshold,
    zeroBitRunLength: Math.round(carrierPeriod * peak0),
    oneBitRunLength: Math.round(carrierPeriod * peak1),
    silenceRunLength: Math.round(carrierMax * 4),
  };
}

// ---------------------------------------------------------------------------
// Line formatting
// ---------------------------------------------------------------------------

function buildLinesForEdit(runs, bitThreshold, silenceRunLength) {
  const linesForEdit = runs.map((run) => {
    let bit;
    if (run.isSync || run.halfPeriodCount < 2) bit = "-";
    else if (run.halfPeriodCount <= bitThreshold) bit = "0";
    else bit = "1";
    return bit + "\t" + run.index + ":" + run.runLength;
  });

  // Mark suspicious long gaps between data bits
  const firstBitIdx = linesForEdit.findIndex((v) => v[0] === "0" || v[0] === "1");
  let scanIdx = linesForEdit.findLastIndex((v) => v[0] === "0" || v[0] === "1");
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
  return { linesForEdit };
}

module.exports = {
  processWavFile,
  loadWav,
  decodeSamples,
};
