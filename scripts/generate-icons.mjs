import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const sizes = [16, 32, 48, 128];
const outputDirectory = new URL("../icons/", import.meta.url);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function isInsideRoundedSquare(x, y, size) {
  const inset = size * 0.04;
  const radius = size * 0.24;
  const left = inset;
  const right = size - 1 - inset;
  const top = inset;
  const bottom = size - 1 - inset;
  const centerX = Math.min(Math.max(x, left + radius), right - radius);
  const centerY = Math.min(Math.max(y, top + radius), bottom - radius);
  const distanceX = x - centerX;
  const distanceY = y - centerY;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
}

function isInsidePlayMark(x, y, size) {
  const left = size * 0.35;
  const right = size * 0.72;
  const centerY = size * 0.5;
  const halfHeight = size * 0.25;
  const distanceY = Math.abs(y - centerY);
  const maximumX = right - (distanceY / halfHeight) * (right - left);
  return distanceY <= halfHeight && x >= left && x <= maximumX;
}

function makePng(size) {
  const stride = size * 4 + 1;
  const pixels = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    pixels[rowStart] = 0;

    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      if (!isInsideRoundedSquare(x, y, size)) {
        continue;
      }

      const gradient = (x + y) / (size * 2);
      pixels[offset] = Math.round(109 + 58 * gradient);
      pixels[offset + 1] = Math.round(40 + 99 * gradient);
      pixels[offset + 2] = Math.round(217 + 33 * gradient);
      pixels[offset + 3] = 255;

      if (isInsidePlayMark(x + 0.5, y + 0.5, size)) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND"),
  ]);
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  sizes.map((size) => writeFile(new URL(`icon-${size}.png`, outputDirectory), makePng(size))),
);

console.log(`Generated Local Clips icons at ${sizes.join(", ")} px.`);
