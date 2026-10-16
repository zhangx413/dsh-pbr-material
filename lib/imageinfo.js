/**
 * Read an image's dimensions without a dependency.
 *
 * Needed because direct mode's whole promise is "the photo, made tileable" — so
 * the report has to state the resolution it actually preserved, and whether the
 * source was big enough to be worth it. Nothing here decodes pixels; only the
 * header is parsed, so it is instant on a 50 MP file.
 */
import { openSync, closeSync, readSync, statSync } from 'node:fs'

function readHead(path, bytes) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function pngSize(buf) {
  // 8-byte signature, then a chunk: length(4) type(4) width(4) height(4)
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function jpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buf[i + 1]
    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    const length = buf.readUInt16BE(i + 2)
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

function webpSize(buf) {
  if (buf.length < 30) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  const kind = buf.toString('latin1', 12, 16)
  if (kind === 'VP8X') {
    return {
      width: 1 + (buf.readUIntLE(24, 3) & 0xffffff),
      height: 1 + (buf.readUIntLE(27, 3) & 0xffffff),
    }
  }
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

/** @returns {{width:number,height:number,bytes:number,format:string|null}|null} */
export function imageSize(path) {
  try {
    const bytes = statSync(path).size
    const buf = readHead(path, 65536)
    let size = null
    let format = null
    for (const [name, fn] of [['png', pngSize], ['jpeg', jpegSize], ['webp', webpSize]]) {
      const hit = fn(buf)
      if (hit) {
        size = hit
        format = name
        break
      }
    }
    if (!size) return { width: null, height: null, bytes, format: null }
    return { ...size, bytes, format }
  } catch {
    return null
  }
}

/** The short side — the number the "don't invent more detail than you have" rule is about. */
export function shortSide(path) {
  const info = imageSize(path)
  if (!info || !info.width || !info.height) return null
  return Math.min(info.width, info.height)
}
