# ZX81 Tape Reader

A desktop app for decoding cassette tape recordings from ZX81, Timex Sinclair 2068, and Lambda 8300 computers. Analyzes WAV audio files using Goertzel frequency detection to recover the original program data, with a visual editor for manual correction of degraded signals.

![Editor window](README/editor_window.png)

## Features

- **Frequency-based decoding** using the Goertzel algorithm to detect 3.2 kHz signal bursts, which works better than amplitude detection on deteriorated tapes
- **Visual waveform display** with zoom (Ctrl+scroll or slider) and pan (scroll or position slider) for inspecting the original audio
- **Interactive bit editor** where detected pulses are shown as 0s, 1s, or ?s for manual review and correction
- **Click-to-navigate** between waveform and editor: click a spot on the waveform to jump to the corresponding bit
- **ZX81 byte viewer** showing hex values and ZX81 character codes for decoded bytes
- **BASIC listing reconstruction** that parses decoded bytes as a ZX81 program with line numbers and expanded keyword tokens
- **Session save/load** (.ztr files) for working across multiple sessions
- **Export** to .tzx (tape image with headers for emulators) and .p (raw ZX81 program file)
- **Built-in user guide** with examples of fixing common tape degradation issues

## Installation

### From release binaries

Download the latest release for your platform from the [Releases](../../releases) page:
- **macOS**: DMG (ARM and Intel)
- **Windows**: Installer (.exe)
- **Linux**: AppImage

### From source

Requires [Node.js](https://nodejs.org/) 22 or later.

```bash
git clone https://github.com/factus10/ZX81-Tape-Reader.git
cd ZX81-Tape-Reader
npm install
npm start
```

## Usage

### 1. Open a WAV file

Use **File > Open WAV...** (Cmd+O / Ctrl+O) to load a tape recording. The tool will analyze the audio for bit patterns. This may take a few seconds depending on file size.

You can also pass a file on the command line:

```bash
npm start -- /path/to/recording.wav
```

### 2. Review and correct

The editor shows detected bits as text lines. Each line has a symbol, sample offset, and run length:

| Symbol | Meaning |
|--------|---------|
| `0` | Zero bit (short pulse) |
| `1` | One bit (long pulse) |
| `?` | Unknown pulse length; needs manual review |
| `-` | Noise (very short burst, ignored) |

Use **Cmd+F** to search for `?` marks and review them against the waveform. Lines marked with `# suspicious loss of signal?` indicate gaps where the signal may have degraded.

When inserting corrected bits, you only need to type the symbol (e.g. `0` or `1`). The offset and run length are inferred automatically.

The **Bytes** tab on the right panel shows the decoded byte values with ZX81 character codes. The **BASIC Listing** tab shows the reconstructed ZX81 BASIC program.

### 3. Save your work

Use **File > Save Session** (Cmd+S) to save progress as a .ztr session file that you can reopen later.

### 4. Export

- **File > Export as .tzx...** for use in ZX81/Spectrum emulators
- **File > Export as .p...** for the raw ZX81 program file

Check the byte count in the status bar before exporting. A non-integer number of bytes usually indicates missing or extra bits.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O | Open WAV file |
| Cmd+Shift+O | Open session |
| Cmd+S | Save session |
| Cmd+Shift+S | Save session as |
| Cmd+F | Find in editor |
| Cmd+Z / Cmd+Shift+Z | Undo / Redo |
| Ctrl+Scroll | Zoom waveform |
| Scroll | Pan waveform |
| F1 | User guide |

## How it works

For each sample in the WAV file, the surrounding slice of samples is analyzed using a [Goertzel algorithm](https://en.wikipedia.org/wiki/Goertzel_algorithm) to detect 3.2 kHz frequencies. Sequences of detected frequencies are collected into runs, and each run's length is compared against the expected lengths for zero and one bit pulses.

This frequency-based approach works better than amplitude detection on deteriorated tapes where signal levels vary across the recording.

## Building

To build a standalone app for your platform:

```bash
npm run dist          # macOS
npm run dist:win      # Windows
npm run dist:linux    # Linux
```

The built app will be in the `dist/` directory.

## Credits

Forked from [zx81-dat-tape-reader](https://github.com/mvindahl/zx81-dat-tape-reader) by [Martin Vindahl Olsen](https://github.com/mvindahl), who created the original Goertzel-based tape decoding approach and interactive editor.

This fork by [David Anderson](https://github.com/factus10) modernizes the app with Electron 41, secure context isolation, session save/load, ZX81 byte decoding, BASIC listing reconstruction, waveform zoom/pan, and standalone app packaging.

## License

ISC
