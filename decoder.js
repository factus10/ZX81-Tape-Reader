// ZX81/TS1000 tape decoder using amplitude-filtered zero-crossing detection.
//
// ZX81 tape format encodes bits as bursts of carrier pulses (~3250 Hz):
//   0-bit: ~4 carrier cycles (fewer pulses)
//   1-bit: ~9 carrier cycles (more pulses)
// At 44100 Hz, one carrier half-period is ~7 samples.
//
// This decoder uses zero-crossing detection with an amplitude filter
// that requires the signal to reach 10% of local peak between crossings,
// plus noise-interval absorption that combines sub-carrier-period intervals
// (from e.g. clipped signal noise) with their neighbors. This is robust
// against:
//   - Asymmetric waveforms where one polarity doesn't reach fixed thresholds
//   - Amplitude variations across the recording (no AGC needed)
//   - Clipped/saturated signals with noise on the flat tops
//   - Noise near zero crossings (filtered by amplitude requirement)
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
  // Scan for sustained carrier signal (not just noise spikes).
  // Require multiple consecutive windows above 25% peak amplitude.
  const winSize = Math.floor(sampleRate * 0.01); // 10ms windows
  let peakAmplitude = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > peakAmplitude) peakAmplitude = Math.abs(samples[i]);
  }
  const signalThreshold = peakAmplitude * 0.25;
  let signalStart = 0;
  let consecutiveAbove = 0;
  const requiredConsecutive = 3; // 30ms of sustained signal
  for (let i = 0; i < samples.length - winSize; i += winSize) {
    let maxInWin = 0;
    for (let j = i; j < i + winSize; j++) {
      if (Math.abs(samples[j]) > maxInWin) maxInWin = Math.abs(samples[j]);
    }
    if (maxInWin > signalThreshold) {
      consecutiveAbove++;
      if (consecutiveAbove >= requiredConsecutive) {
        signalStart = i - (requiredConsecutive - 1) * winSize;
        break;
      }
    } else {
      consecutiveAbove = 0;
    }
  }
  console.log("signal starts at sample:", signalStart,
    "(" + (signalStart / sampleRate).toFixed(2) + "s)");
  console.log("peak amplitude:", peakAmplitude.toFixed(3));

  // --- B. Amplitude-filtered zero-crossing detection ---
  // More robust than hysteresis for signals with asymmetric waveforms or
  // declining amplitude. Counts all carrier cycles by detecting zero crossings
  // where the signal has reached significant amplitude since the last crossing.

  // Cache local peak amplitude in 500-sample windows for performance
  const peakCacheStep = 100;
  const peakCacheWindow = 250; // look ±250 samples
  const peakCache = new Float32Array(
    Math.ceil(samples.length / peakCacheStep)
  );
  for (let i = 0; i < peakCache.length; i++) {
    const start = Math.max(0, i * peakCacheStep - peakCacheWindow);
    const end = Math.min(
      samples.length,
      i * peakCacheStep + peakCacheStep + peakCacheWindow
    );
    let mx = 0;
    for (let j = start; j < end; j++) {
      if (Math.abs(samples[j]) > mx) mx = Math.abs(samples[j]);
    }
    peakCache[i] = mx;
  }

  // Find zero crossings with amplitude filter
  const minAmpFraction = 0.1; // require 10% of local peak between crossings
  const crossings = [];
  let lastSign = samples[signalStart] > 0 ? 1 : -1;
  let maxSinceLast = 0;

  for (let i = signalStart + 1; i < samples.length; i++) {
    if (Math.abs(samples[i]) > maxSinceLast) maxSinceLast = Math.abs(samples[i]);
    const sign = samples[i] > 0 ? 1 : -1;
    if (sign !== lastSign) {
      const ci = Math.min(
        Math.floor(i / peakCacheStep),
        peakCache.length - 1
      );
      if (maxSinceLast > peakCache[ci] * minAmpFraction) {
        crossings.push(i);
        maxSinceLast = 0;
      }
      lastSign = sign;
    }
  }

  console.log("total zero crossings:", crossings.length);

  // --- C. Carrier interval measurement ---
  const rawIntervals = [];
  for (let i = 1; i < crossings.length; i++) {
    rawIntervals.push({
      index: crossings[i - 1],
      length: crossings[i] - crossings[i - 1],
    });
  }

  // --- C2. Noise interval absorption ---
  // When the tape signal is clipped/saturated, noise on the flat tops can
  // create spurious sub-carrier-period zero crossings (intervals of 1-2
  // samples). These would break real carrier bursts into fragments. Absorb
  // these tiny intervals into their neighbors to reconstruct the original
  // burst structure.
  const minCarrierInterval = 3;
  const intervals = [];
  let ii = 0;
  while (ii < rawIntervals.length) {
    const cur = rawIntervals[ii];
    if (cur.length < minCarrierInterval && ii + 1 < rawIntervals.length && intervals.length > 0) {
      // Absorb this tiny interval + the next one into the previous output
      // interval (combining prev + cur + next into one longer interval).
      const next = rawIntervals[ii + 1];
      const prev = intervals[intervals.length - 1];
      prev.length = (next.index + next.length) - prev.index;
      ii += 2;
    } else if (cur.length < minCarrierInterval && intervals.length > 0) {
      // Trailing tiny interval - absorb into previous only.
      const prev = intervals[intervals.length - 1];
      prev.length = (cur.index + cur.length) - prev.index;
      ii++;
    } else {
      intervals.push({ index: cur.index, length: cur.length });
      ii++;
    }
  }

  // --- E. Adaptive threshold for carrier vs gap intervals ---
  // Build histogram of interval lengths to find the carrier peak
  const hist = new Array(80).fill(0);
  const calibrationCount = Math.min(20000, intervals.length);
  for (let i = 0; i < calibrationCount; i++) {
    const len = intervals[i].length;
    if (len >= 3 && len < 80) hist[len]++;
  }

  // Find the carrier peak (short intervals, typically 4-10 range)
  let carrierPeak = 4;
  for (let i = 4; i <= 12; i++) {
    if (hist[i] > hist[carrierPeak]) carrierPeak = i;
  }

  // Find carrierMax: the valley between carrier intervals and gap intervals
  // Look for the first minimum after the carrier peak
  let carrierMax = carrierPeak + 3; // fallback
  let minCount = Infinity;
  for (let i = carrierPeak + 1; i <= carrierPeak + 8; i++) {
    if (i < 80 && hist[i] < minCount) {
      minCount = hist[i];
      carrierMax = i;
    }
  }

  console.log("carrier peak at:", carrierPeak, "samples");
  console.log("carrier max threshold:", carrierMax, "samples");

  // --- G. Burst grouping by carrier intervals ---
  // ZX81 tape format: each bit is a burst of carrier cycles separated by gaps.
  //   0-bit: ~4 carrier cycles (fewer pulses)
  //   1-bit: ~9 carrier cycles (more pulses)
  //
  // Group consecutive carrier-frequency intervals into bursts,
  // then classify by cycle count.

  let bursts = [];
  let burstStart = -1;
  let burstSampleStart = 0;
  let burstIntervals = 0;
  let burstSampleEnd = 0;

  for (let j = 0; j < intervals.length; j++) {
    const iv = intervals[j];
    const isCarrier = iv.length >= 3 && iv.length <= carrierMax;

    if (isCarrier) {
      if (burstStart === -1) {
        burstStart = j;
        burstSampleStart = iv.index;
        burstIntervals = 1;
      } else {
        burstIntervals++;
      }
      burstSampleEnd = iv.index + iv.length;
    } else {
      if (burstStart !== -1 && burstIntervals >= 3) {
        const cycles = Math.round((burstIntervals + 1) / 2);
        bursts.push({
          index: burstSampleStart,
          runLength: burstSampleEnd - burstSampleStart,
          halfPeriodCount: cycles, // store cycle count for compatibility
        });
      }
      burstStart = -1;
      burstIntervals = 0;

      // Track non-data gaps for display
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
  if (burstStart !== -1 && burstIntervals >= 3) {
    const cycles = Math.round((burstIntervals + 1) / 2);
    bursts.push({
      index: burstSampleStart,
      runLength: burstSampleEnd - burstSampleStart,
      halfPeriodCount: cycles,
    });
  }

  // Find the threshold between 0-bit cycle counts and 1-bit cycle counts
  const burstHist = new Array(30).fill(0);
  for (const b of bursts) {
    if (!b.isSync && b.halfPeriodCount >= 2 && b.halfPeriodCount < 30) {
      burstHist[b.halfPeriodCount]++;
    }
  }

  console.log("burst cycle count histogram:");
  for (let k = 2; k < 20; k++) {
    if (burstHist[k] > 0)
      console.log("  " + k + " cycles: " + burstHist[k]);
  }

  // Find two peaks: 0-bit peak (fewer cycles) and 1-bit peak (more cycles)
  let peak0 = 3, peak1 = 8;
  for (let k = 3; k <= 7; k++) {
    if (burstHist[k] > burstHist[peak0]) peak0 = k;
  }
  for (let k = 7; k <= 15; k++) {
    if (burstHist[k] > burstHist[peak1]) peak1 = k;
  }

  let bitThreshold = Math.floor((peak0 + peak1) / 2) + 0.5;
  // Find actual valley
  let minVal = Infinity;
  for (let k = peak0 + 1; k < peak1; k++) {
    if (burstHist[k] < minVal) {
      minVal = burstHist[k];
      bitThreshold = k + 0.5;
    }
  }

  console.log(
    "bit threshold:",
    bitThreshold,
    "cycles (0-bit peak=" + peak0 + ", 1-bit peak=" + peak1 + ")"
  );

  const runs = bursts;

  // Approximate run lengths for waveform display
  const carrierPeriod = carrierPeak * 2;
  const zeroBitRunLength = Math.round(carrierPeriod * peak0);
  const oneBitRunLength = Math.round(carrierPeriod * peak1);
  const silenceRunLength = Math.round(carrierMax * 4);

  console.log("zero bit run length:", zeroBitRunLength);
  console.log("one bit run length:", oneBitRunLength);

  // Build editor lines
  // ZX81 format: fewer cycles = 0-bit, more cycles = 1-bit
  const linesForEdit = runs.map((run) => {
    let bitAsString;
    if (run.isSync) {
      bitAsString = "-";
    } else if (run.halfPeriodCount < 2) {
      bitAsString = "-";
    } else if (run.halfPeriodCount <= bitThreshold) {
      bitAsString = "0";
    } else {
      bitAsString = "1";
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
