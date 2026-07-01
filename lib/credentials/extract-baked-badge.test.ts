import { expect, test } from "vitest";
import { extractBakedAssertion } from "./extract-baked-badge";

// --- Hand-build a minimal PNG with one iTXt chunk keyed "openbadges" ---
// We do NOT need a valid image — only the chunk framing the parser scans.
// Chunk layout: 4-byte big-endian length | 4-byte type | data | 4-byte CRC.
// iTXt data: keyword \0 compressionFlag(1) compressionMethod(1) langTag \0
//            translatedKeyword \0 text
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); // parser ignores CRC; zeros are fine
  return Buffer.concat([len, typeBuf, data, crc]);
}

function iTXtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, "ascii"),
    Buffer.from([0]), // null after keyword
    Buffer.from([0]), // compression flag (0 = uncompressed)
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag + null
    Buffer.from([0]), // empty translated keyword + null
    Buffer.from(text, "utf8"),
  ]);
  return chunk("iTXt", data);
}

function tEXtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, "ascii"),
    Buffer.from([0]), // null separator
    Buffer.from(text, "latin1"),
  ]);
  return chunk("tEXt", data);
}

const ASSERTION = { type: "Assertion", badge: { name: "Baked Badge" } };

test("extracts an assertion from a PNG iTXt chunk keyed 'openbadges'", () => {
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    iTXtChunk("openbadges", JSON.stringify(ASSERTION)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toEqual(ASSERTION);
});

test("extracts an assertion from a PNG tEXt chunk keyed 'openbadges'", () => {
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    tEXtChunk("openbadges", JSON.stringify(ASSERTION)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toEqual(ASSERTION);
});

test("PNG with no openbadges chunk returns null", () => {
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    iTXtChunk("Description", "just a picture"),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toBeNull();
});

test("compressed iTXt (compressionFlag=1) is unsupported in v1 -> null (documents the boundary)", () => {
  // Real production baked PNGs sometimes zlib-compress the iTXt payload. v1 does not inflate it;
  // it returns null so the caller stores the image honestly `unverified` rather than crashing.
  const data = Buffer.concat([
    Buffer.from("openbadges", "ascii"),
    Buffer.from([0]), // null after keyword
    Buffer.from([1]), // compression flag = 1 (COMPRESSED — unsupported)
    Buffer.from([0]), // compression method
    Buffer.from([0]), // empty language tag + null
    Buffer.from([0]), // empty translated keyword + null
    Buffer.from([0x78, 0x9c, 0x01]), // bogus "compressed" bytes; must not be parsed
  ]);
  const png = Buffer.concat([
    PNG_SIG,
    chunk("IHDR", Buffer.alloc(13)),
    chunk("iTXt", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(extractBakedAssertion(png, "image/png")).toBeNull();
});

test("extracts an assertion from an SVG <openbadges:assertion> element", () => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:openbadges="http://openbadges.org">` +
    `<openbadges:assertion verify="x">${JSON.stringify(ASSERTION)}</openbadges:assertion>` +
    `</svg>`;
  expect(extractBakedAssertion(Buffer.from(svg, "utf8"), "image/svg+xml")).toEqual(
    ASSERTION
  );
});

test("SVG without an assertion element returns null", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
  expect(extractBakedAssertion(Buffer.from(svg, "utf8"), "image/svg+xml")).toBeNull();
});

test("garbage bytes never throw — return null", () => {
  expect(extractBakedAssertion(Buffer.from([1, 2, 3, 4]), "image/png")).toBeNull();
  expect(extractBakedAssertion(Buffer.from("<svg", "utf8"), "image/svg+xml")).toBeNull();
});
