import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";

const MAX_ARCHIVE = 256_000;
const MAX_RESULT = 128_000;
const NAME = Buffer.from("result.json", "utf8");
const INVALID = "QA artifact archive verification failed.";
export type QaArtifactMetadata = { digest: string; sizeInBytes: number };

function requireCondition(condition: boolean): asserts condition {
  if (!condition) throw new Error(INVALID);
}
function extraFields(buffer: Buffer, start: number, end: number): void {
  let offset = start;
  while (offset < end) {
    requireCondition(offset + 4 <= end);
    const identifier = buffer.readUInt16LE(offset);
    const length = buffer.readUInt16LE(offset + 2);
    // ZIP64 and encryption extensions are never needed by this small receipt.
    requireCondition(identifier !== 0x0001 && identifier !== 0x0017 && identifier !== 0x9901);
    offset += 4 + length;
    requireCondition(offset <= end);
  }
}

function resultFile(archive: Buffer): Buffer {
  // EOCD comments are bounded by the ZIP format; its end must be archive EOF.
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 65_535); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) { end = offset; break; }
  }
  requireCondition(end >= 0);
  requireCondition(archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0
    && archive.readUInt16LE(end + 8) === 1 && archive.readUInt16LE(end + 10) === 1);
  const directorySize = archive.readUInt32LE(end + 12);
  const directory = archive.readUInt32LE(end + 16);
  requireCondition(directory !== 0xffffffff && directorySize !== 0xffffffff
    && directory >= 30 && directory + directorySize === end && directorySize >= 46);
  requireCondition(archive.readUInt32LE(directory) === 0x02014b50);
  const version = archive.readUInt16LE(directory + 6);
  const flags = archive.readUInt16LE(directory + 8);
  const method = archive.readUInt16LE(directory + 10);
  const checksum = archive.readUInt32LE(directory + 16);
  const compressedSize = archive.readUInt32LE(directory + 20);
  const resultSize = archive.readUInt32LE(directory + 24);
  const nameLength = archive.readUInt16LE(directory + 28);
  const extraLength = archive.readUInt16LE(directory + 30);
  const commentLength = archive.readUInt16LE(directory + 32);
  requireCondition(version <= 20 && (flags & ~0x0808) === 0 && (method === 0 || method === 8)
    && compressedSize !== 0xffffffff && resultSize <= MAX_RESULT
    && archive.readUInt16LE(directory + 34) === 0 && archive.readUInt32LE(directory + 42) === 0
    && 46 + nameLength + extraLength + commentLength === directorySize && nameLength === NAME.length);
  requireCondition(archive.subarray(directory + 46, directory + 46 + nameLength).equals(NAME));
  extraFields(archive, directory + 46 + nameLength, directory + 46 + nameLength + extraLength);

  // Exactly one local entry begins at offset zero: no prefix or hidden entries.
  requireCondition(archive.readUInt32LE(0) === 0x04034b50 && archive.readUInt16LE(4) === version
    && archive.readUInt16LE(6) === flags && archive.readUInt16LE(8) === method
    && archive.readUInt16LE(10) === archive.readUInt16LE(directory + 12)
    && archive.readUInt16LE(12) === archive.readUInt16LE(directory + 14));
  const localCrc = archive.readUInt32LE(14);
  const localCompressed = archive.readUInt32LE(18);
  const localResult = archive.readUInt32LE(22);
  const localNameLength = archive.readUInt16LE(26);
  const localExtraLength = archive.readUInt16LE(28);
  const payload = 30 + localNameLength + localExtraLength;
  const payloadEnd = payload + compressedSize;
  requireCondition(localNameLength === NAME.length && payload <= directory && payloadEnd <= directory
    && archive.subarray(30, 30 + localNameLength).equals(NAME));
  extraFields(archive, 30 + localNameLength, payload);
  if ((flags & 0x0008) !== 0) {
    requireCondition((localCrc === 0 || localCrc === checksum) && (localCompressed === 0 || localCompressed === compressedSize)
      && (localResult === 0 || localResult === resultSize));
    const length = directory - payloadEnd;
    requireCondition(length === 12 || length === 16);
    if (length === 16) requireCondition(archive.readUInt32LE(payloadEnd) === 0x08074b50);
    const descriptor = payloadEnd + (length === 16 ? 4 : 0);
    requireCondition(archive.readUInt32LE(descriptor) === checksum && archive.readUInt32LE(descriptor + 4) === compressedSize
      && archive.readUInt32LE(descriptor + 8) === resultSize);
  } else {
    requireCondition(payloadEnd === directory && localCrc === checksum && localCompressed === compressedSize && localResult === resultSize);
  }
  const compressed = archive.subarray(payload, payloadEnd);
  let output: Buffer;
  if (method === 0) {
    requireCondition(compressedSize === resultSize);
    output = compressed;
  } else {
    const inflated = inflateRawSync(compressed, { maxOutputLength: MAX_RESULT, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    requireCondition(inflated.engine.bytesWritten === compressedSize);
    output = inflated.buffer;
  }
  requireCondition(output.length === resultSize && output.length <= MAX_RESULT && crc32(output) === checksum);
  return output;
}

/** Metadata must come from the exact trusted run's authenticated GitHub API. */
export async function readQaArtifactArchive(path: string, metadata: QaArtifactMetadata): Promise<string> {
  try {
    requireCondition(typeof metadata.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(metadata.digest)
      && Number.isSafeInteger(metadata.sizeInBytes) && metadata.sizeInBytes >= 22 && metadata.sizeInBytes <= MAX_ARCHIVE);
    // Reject symlinks and avoid blocking on a replaced FIFO before fstat can
    // confirm that the descriptor is a regular bounded archive file.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let archive: Buffer;
    try {
      const stat = await handle.stat();
      requireCondition(stat.isFile() && stat.size === metadata.sizeInBytes);
      archive = Buffer.alloc(metadata.sizeInBytes);
      let position = 0;
      while (position < archive.length) {
        const { bytesRead } = await handle.read(archive, position, archive.length - position, position);
        requireCondition(bytesRead > 0);
        position += bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, position);
      requireCondition(extra.bytesRead === 0);
    } finally { await handle.close(); }
    const digest = createHash("sha256").update(archive).digest();
    requireCondition(timingSafeEqual(digest, Buffer.from(metadata.digest.slice(7), "hex")));
    // Hash and bounded exact archive size are authenticated before decompression.
    return new TextDecoder("utf-8", { fatal: true }).decode(resultFile(archive));
  } catch { throw new Error(INVALID); }
}
