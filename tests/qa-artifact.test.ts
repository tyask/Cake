import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, rm, writeFile, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { readQaArtifactArchive, type QaArtifactMetadata } from "../scripts/qa-artifact";

const CONTENT = '{"protocol":"test-result/v1","status":"success"}';
const metadata = (archive: Buffer): QaArtifactMetadata => ({ digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`, sizeInBytes: archive.length });
type ZipOptions = { method?: number; flags?: number; name?: string; localName?: string; content?: Buffer; declaredResultSize?: number; descriptorSignature?: boolean; extra?: Buffer };
function zip({ method = 8, flags = 0, name = "result.json", localName = name, content = Buffer.from(CONTENT), declaredResultSize = content.length,
  descriptorSignature = true, extra = Buffer.alloc(0) }: ZipOptions = {}): Buffer {
  const fileName = Buffer.from(name);
  const localFileName = Buffer.from(localName);
  const compressed = method === 0 ? content : deflateRawSync(content);
  const checksum = crc32(content);
  const descriptor = (flags & 8) !== 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(descriptor ? 0 : checksum, 14); local.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
  local.writeUInt32LE(descriptor ? 0 : declaredResultSize, 22); local.writeUInt16LE(localFileName.length, 26); local.writeUInt16LE(extra.length, 28);
  const trailer = Buffer.alloc(descriptor ? descriptorSignature ? 16 : 12 : 0);
  if (descriptor) {
    let offset = 0;
    if (descriptorSignature) { trailer.writeUInt32LE(0x08074b50); offset = 4; }
    trailer.writeUInt32LE(checksum, offset); trailer.writeUInt32LE(compressed.length, offset + 4); trailer.writeUInt32LE(declaredResultSize, offset + 8);
  }
  const localRecord = Buffer.concat([local, localFileName, extra, compressed, trailer]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredResultSize, 24);
  central.writeUInt16LE(fileName.length, 28); central.writeUInt16LE(extra.length, 30);
  const directory = Buffer.concat([central, fileName, extra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, directory, end]);
}
function directoryOffset(archive: Buffer): number { return archive.readUInt32LE(archive.length - 6); }
function mutate(archive: Buffer, change: (copy: Buffer, central: number) => void): Buffer {
  const copy = Buffer.from(archive); change(copy, directoryOffset(copy)); return copy;
}
function twoFiles(): Buffer {
  const first = zip(); const second = zip();
  const firstCentral = directoryOffset(first); const secondCentral = directoryOffset(second);
  const secondDirectory = Buffer.from(second.subarray(secondCentral, second.length - 22));
  secondDirectory.writeUInt32LE(firstCentral, 42);
  const entries = Buffer.concat([first.subarray(0, firstCentral), second.subarray(0, secondCentral)]);
  const directory = Buffer.concat([first.subarray(firstCentral, first.length - 22), secondDirectory]);
  const end = Buffer.from(first.subarray(first.length - 22));
  end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(entries.length, 16);
  return Buffer.concat([entries, directory, end]);
}
async function readFixture(archive: Buffer, expected = metadata(archive)): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "cake-qa-artifact-"));
  try {
    const path = join(folder, "receipt.zip");
    await writeFile(path, archive, { mode: 0o600 });
    return await readQaArtifactArchive(path, expected);
  } finally { await rm(folder, { recursive: true, force: true }); }
}
const rejects = (archive: Buffer, expected?: QaArtifactMetadata) => assert.rejects(readFixture(archive, expected), error => {
  assert.equal(String(error), "Error: QA artifact archive verification failed."); return true;
});

test("single stored/deflated UTF8 receipts and both data descriptor formats are accepted", async () => {
  for (const options of [{ method: 0 }, { method: 8 }, { flags: 0x0800 }, { flags: 8 }, { flags: 0x0808, descriptorSignature: false }]) {
    assert.equal(await readFixture(zip(options)), CONTENT);
  }
});

test("authenticated digest and exact bounded size must match before receipt bytes are used", async () => {
  const archive = zip();
  for (const expected of [
    { ...metadata(archive), digest: `sha256:${"0".repeat(64)}` },
    { ...metadata(archive), digest: "missing" }, { ...metadata(archive), digest: `sha512:${"a".repeat(64)}` },
    { ...metadata(archive), sizeInBytes: archive.length + 1 }, { ...metadata(archive), sizeInBytes: archive.length - 1 },
    { ...metadata(archive), sizeInBytes: 256_001 }, { ...metadata(archive), sizeInBytes: NaN },
  ]) await rejects(archive, expected);
  await rejects(Buffer.concat([archive, Buffer.alloc(256_001)]));
});

test("encrypted archives, unsupported methods, multiple entries, traversal and name mismatches are rejected", async () => {
  for (const archive of [zip({ flags: 1 }), zip({ flags: 0x0040 }), zip({ method: 9 }), twoFiles(),
    zip({ name: "../result.json" }), zip({ name: "nested/result.json" }), zip({ name: "wrong.json" }),
    zip({ localName: "other_.json" }), zip({ extra: Buffer.from([1, 0, 0, 0]) }),
    mutate(zip(), (copy, central) => { copy.writeUInt32LE(0xffffffff, central + 20); }),
  ]) await rejects(archive);
});

test("truncation, conflicting headers, CRC corruption and descriptor inconsistencies are rejected", async () => {
  const original = zip();
  for (const archive of [original.subarray(0, original.length - 1), original.subarray(0, 40),
    mutate(original, copy => { copy.writeUInt16LE(8, 6); }),
    mutate(original, (copy, central) => { copy.writeUInt32LE(1, central + 42); }),
    mutate(original, (copy, central) => { copy.writeUInt32LE(0, 14); copy.writeUInt32LE(0, central + 16); }),
    mutate(original, (copy, central) => { copy.writeUInt32LE(500_000, central + 24); }),
    mutate(zip({ flags: 8 }), (copy, central) => { copy.writeUInt32LE(0, central - 8); }),
    zip({ extra: Buffer.from([2, 0, 250, 0]) }),
    zip({ content: Buffer.from([0xff, 0xfe]) }),
  ]) await rejects(archive);
});

test("decompression is bounded even when an authenticated archive lies about its output size", async () => {
  await rejects(zip({ content: Buffer.alloc(256_000, 65), declaredResultSize: 100 }));
  await rejects(zip({ content: Buffer.alloc(128_001, 65) }));
  await rejects(zip({ method: 0, content: Buffer.alloc(100), declaredResultSize: 99 }));
  const withTrailingDeflateBytes = zip();
  const central = directoryOffset(withTrailingDeflateBytes);
  const copied = Buffer.concat([withTrailingDeflateBytes.subarray(0, central), Buffer.from([0]), withTrailingDeflateBytes.subarray(central)]);
  copied.writeUInt32LE(copied.readUInt32LE(18) + 1, 18);
  copied.writeUInt32LE(copied.readUInt32LE(central + 1 + 20) + 1, central + 1 + 20);
  copied.writeUInt32LE(central + 1, copied.length - 6);
  await rejects(copied);
});

test("filesystem failures return only the fixed diagnostic", async () => {
  await assert.rejects(readQaArtifactArchive("/nonexistent/private-path/receipt.zip", metadata(zip())), error => {
    assert.equal(String(error), "Error: QA artifact archive verification failed."); return true;
  });
});

test("an artifact symlink is rejected even when its target has the authenticated bytes", { skip: !constants.O_NOFOLLOW }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "cake-qa-artifact-link-"));
  try {
    const archive = zip();
    const target = join(folder, "target.zip");
    const link = join(folder, "receipt.zip");
    await writeFile(target, archive, { mode: 0o600 });
    await symlink(target, link);
    assert.equal(await readQaArtifactArchive(target, metadata(archive)), CONTENT);
    await assert.rejects(readQaArtifactArchive(link, metadata(archive)), error => {
      assert.equal(String(error), "Error: QA artifact archive verification failed."); return true;
    });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

const compatibilityZip = process.env.CAKE_QA_ARTIFACT_COMPATIBILITY_ZIP;
test("the downloaded native GitHub upload-artifact archive matches its authenticated digest and parses", { skip: !compatibilityZip }, async () => {
  await access(compatibilityZip!);
  const result = JSON.parse(await readQaArtifactArchive(compatibilityZip!, {
    digest: "sha256:e2664b91c89071ac2caeb48535703a65f5a93ca2a98f8be0a1c8ad5582a0038b", sizeInBytes: 250,
  }));
  assert.equal(result.protocol, "cake-qa-result/v1");
  assert.equal(result.action, "status");
  assert.equal(result.status, "success");
  assert.equal(result.payload, null);
});
