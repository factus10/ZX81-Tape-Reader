// ZX81 character set and BASIC token mapping

const CHARS = [
  " ", "\u2598", "\u259D", "\u2580", "\u2596", "\u258C", "\u259E", "\u259B",  // 0x00-0x07
  "\u2592", "\u2590", "\u259A", "\u2584", "\u259F", "\u2599", "\u2586", "\u2588",  // 0x08-0x0F (0x08=graphic, rest vary)
  // Remap: actual ZX81 codes
];

// Build the full 256-entry character table
const charTable = new Array(256).fill("?");

// 0x00: space
charTable[0x00] = " ";

// 0x01-0x0A: graphic block characters
charTable[0x01] = "\u2598"; // quadrant upper left
charTable[0x02] = "\u259D"; // quadrant upper right
charTable[0x03] = "\u2580"; // upper half
charTable[0x04] = "\u2596"; // quadrant lower left
charTable[0x05] = "\u258C"; // left half
charTable[0x06] = "\u259E"; // quadrant upper right and lower left
charTable[0x07] = "\u259B"; // upper left and upper right and lower left
charTable[0x08] = "\u2592"; // medium shade (grey)
charTable[0x09] = "\u2590"; // right half (or inverse of 0x05)
charTable[0x0A] = "\u259A"; // quadrant upper left and lower right

// 0x0B: "
charTable[0x0B] = '"';
// 0x0C-0x0F
charTable[0x0C] = "\u00A3"; // £
charTable[0x0D] = "$";
charTable[0x0E] = ":";
charTable[0x0F] = "?";
// 0x10-0x15
charTable[0x10] = "(";
charTable[0x11] = ")";
charTable[0x12] = ">";
charTable[0x13] = "<";
charTable[0x14] = "=";
charTable[0x15] = "+";
// 0x16-0x1B
charTable[0x16] = "-";
charTable[0x17] = "*";
charTable[0x18] = "/";
charTable[0x19] = ";";
charTable[0x1A] = ",";
charTable[0x1B] = ".";
// 0x1C-0x25: digits 0-9
for (let i = 0; i <= 9; i++) {
  charTable[0x1C + i] = String(i);
}
// 0x26-0x3F: letters A-Z
for (let i = 0; i < 26; i++) {
  charTable[0x26 + i] = String.fromCharCode(65 + i);
}

// 0x40-0x7F: inverse video versions (show as [INV X])
for (let i = 0x40; i <= 0x7F; i++) {
  const base = charTable[i - 0x40];
  charTable[i] = base; // display same char, could mark as inverse
}

// 0x76: NEWLINE
charTable[0x76] = "\n";

// 0x7E: number marker (followed by 5-byte float)
charTable[0x7E] = "[NUM]";

// 0xC0-0xFF: BASIC keyword tokens
const keywords = [
  '""', "AT", "TAB", "?", "CODE", "VAL", "LEN", "SIN",       // 0xC0-0xC7
  "COS", "TAN", "ASN", "ACS", "ATN", "LN", "EXP", "INT",     // 0xC8-0xCF
  "SQR", "SGN", "ABS", "PEEK", "USR", "STR$", "CHR$", "NOT",  // 0xD0-0xD7
  "**", "OR", "AND", "<=", ">=", "<>", "THEN", "TO",           // 0xD8-0xDF
  "STEP", "LPRINT", "LLIST", "STOP", "SLOW", "FAST", "NEW",    // 0xE0-0xE6
  "SCROLL", "CONT", "DIM", "REM", "FOR", "GOTO", "GOSUB",     // 0xE7-0xED
  "INPUT", "LOAD", "LIST", "LET", "PAUSE", "NEXT", "POKE",    // 0xEE-0xF4
  "PRINT", "PLOT", "RUN", "SAVE", "RAND", "IF", "CLS",        // 0xF5-0xFB
  "UNPLOT", "CLEAR", "RETURN", "COPY",                         // 0xFC-0xFF
];

for (let i = 0; i < keywords.length; i++) {
  charTable[0xC0 + i] = keywords[i];
}

// Convert a byte to its ZX81 character representation
function byteToChar(b) {
  return charTable[b] || "?";
}

// Convert a byte to a display-friendly string (for the char column)
function byteToDisplay(b) {
  if (b === 0x76) return "NL";
  if (b === 0x7E) return "#";
  if (b >= 0xC0) return charTable[b];
  if (b >= 0x40 && b <= 0x7F) return "[" + charTable[b - 0x40] + "]";
  if (b === 0x00) return "\u00B7"; // middle dot for space
  return charTable[b];
}

// Parse raw bytes as a ZX81 BASIC program listing
// ZX81 program format: each line is:
//   2 bytes: line number (big-endian)
//   2 bytes: line length (little-endian, includes trailing NEWLINE)
//   N bytes: line content
//   0x76: NEWLINE terminator
function decodeListing(bytes) {
  const lines = [];
  let pos = 0;

  while (pos + 4 < bytes.length) {
    const lineNum = (bytes[pos] << 8) | bytes[pos + 1];
    const lineLen = bytes[pos + 2] | (bytes[pos + 3] << 8);

    // Sanity checks
    if (lineNum === 0 || lineNum > 9999 || lineLen === 0 || lineLen > 1024) {
      break;
    }

    pos += 4;
    let text = "";
    let remaining = lineLen;
    let inRem = false;

    while (remaining > 0 && pos < bytes.length) {
      const b = bytes[pos];
      pos++;
      remaining--;

      if (b === 0x76) {
        // NEWLINE — end of line
        break;
      }

      if (b === 0x7E && !inRem) {
        // Number marker: skip the next 5 bytes (floating point representation)
        pos += 5;
        remaining -= 5;
        continue;
      }

      if (b >= 0xC0) {
        const kw = charTable[b];
        // Keywords after line start get a leading space for readability
        if (b === 0xEA) inRem = true; // REM — rest is literal
        if (text.length > 0 && b >= 0xE1) {
          text += " " + kw + " ";
        } else {
          text += kw;
        }
      } else {
        text += charTable[b] || "?";
      }
    }

    lines.push(lineNum + " " + text.trim());
  }

  return lines;
}

// Export for use in main process (Node.js require)
if (typeof module !== "undefined") {
  module.exports = { byteToChar, byteToDisplay, decodeListing, charTable };
}
