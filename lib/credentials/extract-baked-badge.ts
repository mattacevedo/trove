// Best-effort baked-badge assertion extractor. Never throws — returns null on any failure.
// PNG spec: https://www.imsglobal.org/openbadges/baked

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BAKED_KEYWORD = "openbadges";

function tryJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Walk PNG chunks; return the text payload of an iTXt/tEXt chunk keyed "openbadges". */
function readPngBakedText(buffer: Buffer): string | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) break; // truncated / malformed
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "tEXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const keyword = data.toString("ascii", 0, nul);
        if (keyword === BAKED_KEYWORD) {
          if (type === "tEXt") {
            return data.toString("latin1", nul + 1);
          }
          // iTXt: after keyword\0 comes compressionFlag(1), compressionMethod(1),
          // langTag\0, translatedKeyword\0, then the (uncompressed) text.
          const compressionFlag = data[nul + 1];
          if (compressionFlag !== 0) return null; // compressed iTXt unsupported in v1
          const p = nul + 3; // skip flag + method
          const langEnd = data.indexOf(0, p);
          if (langEnd === -1) return null;
          const transEnd = data.indexOf(0, langEnd + 1);
          if (transEnd === -1) return null;
          return data.toString("utf8", transEnd + 1);
        }
      }
    }
    offset = dataEnd + 4; // skip 4-byte CRC
    if (type === "IEND") break;
  }
  return null;
}

/** Pull assertion JSON from an SVG <openbadges:assertion> element (or plain <assertion>). */
function readSvgBakedText(svg: string): string | null {
  const match =
    svg.match(/<openbadges:assertion[^>]*>([\s\S]*?)<\/openbadges:assertion>/) ??
    svg.match(/<assertion[^>]*>([\s\S]*?)<\/assertion>/);
  return match ? match[1].trim() : null;
}

/**
 * Extract an embedded Open Badges assertion from a baked PNG or SVG.
 * Returns the parsed JSON, or null when nothing parseable is embedded.
 */
export function extractBakedAssertion(
  buffer: Buffer,
  mime: "image/png" | "image/svg+xml"
): unknown | null {
  try {
    const text =
      mime === "image/png"
        ? readPngBakedText(buffer)
        : readSvgBakedText(buffer.toString("utf8"));
    if (!text) return null;
    return tryJson(text);
  } catch {
    return null;
  }
}
