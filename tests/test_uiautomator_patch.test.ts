/**
 * 不等 idle 的 uiautomator.jar 改写：只 NOP `waitForIdle(long, long)`，
 * 同名的无参重载和其他调用保持原样，并重算 dex checksum。
 */
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { patchUiautomatorDex, patchUiautomatorJar } from "../src/inspector/uiautomatorPatch";

const WAIT_INVOKE = Buffer.from([0x6e, 0x53, 0x00, 0x00, 0x04, 0x21]);
const ZERO_INVOKE = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const OTHER_INVOKE = Buffer.from([0x6e, 0x10, 0x01, 0x00, 0x00, 0x00]);
const VOID_WAIT_INVOKE = Buffer.from([0x6e, 0x20, 0x02, 0x00, 0x00, 0x00]);

describe("patchUiautomatorDex", () => {
  it("只 NOP waitForIdle(JJ)V，无参重载和其他调用保留，checksum 重算", () => {
    const dex = buildFixtureDex();
    expect(dex.includes(WAIT_INVOKE)).toBe(true);

    const patched = patchUiautomatorDex(dex);
    const at = dex.indexOf(WAIT_INVOKE);
    expect(at).toBeGreaterThan(0);
    expect(patched.subarray(at, at + 6).equals(ZERO_INVOKE)).toBe(true);
    expect(patched.includes(OTHER_INVOKE)).toBe(true);
    expect(patched.includes(VOID_WAIT_INVOKE)).toBe(true);
    expect(dex.includes(WAIT_INVOKE)).toBe(true);
    expect(adler32(patched.subarray(12))).toBe(patched.readUInt32LE(8));
    expect(createHash("sha1").update(patched.subarray(32)).digest().equals(patched.subarray(12, 32))).toBe(
      true,
    );
  });

  it("第二次改写找不到调用，抛错", () => {
    const once = patchUiautomatorDex(buildFixtureDex());
    expect(() => patchUiautomatorDex(once)).toThrow(/没有找到 waitForIdle 调用/);
  });

  it("打印 idle 失败文案的方法把 waitForIdle(JJ) 换成 SystemClock.sleep，无参重载保留", () => {
    const dex = buildIdleDumpDex();
    const patched = patchUiautomatorDex(dex);
    const at = dex.indexOf(WAIT_INVOKE);
    // sleep(v0) ：invoke-static，method id 3，寄存器 v0+v1
    expect(patched.subarray(at, at + 6)).toEqual(Buffer.from([0x71, 0x20, 0x03, 0x00, 0x10, 0x00]));
    expect(patched.includes(VOID_WAIT_INVOKE)).toBe(true);
    expect(patched.includes(OTHER_INVOKE)).toBe(true);
    expect(adler32(patched.subarray(12))).toBe(patched.readUInt32LE(8));
  });

  it("zip 里的 deflate classes.dex 同样被改写", () => {
    const dex = buildFixtureDex();
    const jar = zipWithDeflatedDex(dex);
    const patchedJar = patchUiautomatorJar(jar);
    const patchedDex = unzipDex(patchedJar);
    expect(patchedDex.includes(WAIT_INVOKE)).toBe(false);
    expect(patchedDex.includes(OTHER_INVOKE)).toBe(true);
    expect(adler32(patchedDex.subarray(12))).toBe(patchedDex.readUInt32LE(8));
  });
});

function adler32(buf: Buffer): number {
  const mod = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + (buf[i] ?? 0)) % mod;
    b = (b + a) % mod;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * 最小 dex：一个方法体里依次调用
 * `waitForIdle()V`、`other()V`、`waitForIdle(JJ)V`，然后 return-void。
 * 字符串按下标直接引用，不依赖 dex 的排序校验（改写器按索引读）。
 */
function buildFixtureDex(): Buffer {
  const strings = ["J", "V", "VJJ", "other", "waitForIdle"];
  const stringData = Buffer.concat(strings.map(encodeMutf8));
  const stringIds = Buffer.alloc(strings.length * 4);
  let cursor = 0;
  for (let i = 0; i < strings.length; i++) {
    stringIds.writeUInt32LE(cursor, i * 4);
    cursor += 1 + (strings[i]?.length ?? 0) + 1;
  }

  // type 0 = V (string 1), type 1 = J (string 0)
  const typeIds = Buffer.alloc(8);
  typeIds.writeUInt32LE(1, 0);
  typeIds.writeUInt32LE(0, 4);

  // params (J, J), 4-byte aligned later
  const typeList = Buffer.alloc(8);
  typeList.writeUInt32LE(2, 0);
  typeList.writeUInt16LE(1, 4);
  typeList.writeUInt16LE(1, 6);

  // proto 0: (JJ)V shorty VJJ string 2, return type 0
  // proto 1: ()V shorty V string 1, return type 0, no params
  const protoIds = Buffer.alloc(24);
  protoIds.writeUInt32LE(2, 0);
  protoIds.writeUInt32LE(0, 4);
  protoIds.writeUInt32LE(1, 12);
  protoIds.writeUInt32LE(0, 16);

  // method 0 waitForIdle (JJ)V, method 1 other ()V, method 2 waitForIdle ()V
  const methodIds = Buffer.alloc(24);
  methodIds.writeUInt16LE(0, 2);
  methodIds.writeUInt32LE(4, 4);
  methodIds.writeUInt16LE(1, 8);
  methodIds.writeUInt16LE(1, 10);
  methodIds.writeUInt32LE(3, 12);
  methodIds.writeUInt16LE(2, 16);
  methodIds.writeUInt16LE(1, 18);
  methodIds.writeUInt32LE(4, 20);

  const insns = Buffer.concat([
    VOID_WAIT_INVOKE,
    OTHER_INVOKE,
    WAIT_INVOKE,
    Buffer.from([0x0e, 0x00]),
  ]);
  const code = Buffer.alloc(16 + insns.length);
  code.writeUInt16LE(5, 0);
  code.writeUInt16LE(5, 4);
  code.writeUInt32LE(insns.length / 2, 12);
  insns.copy(code, 16);

  const headerSize = 0x70;
  const idsSize = stringIds.length + typeIds.length + protoIds.length + methodIds.length + 32;
  const dataOff = align4(headerSize + idsSize);
  const stringOff = dataOff;
  const typeListOff = align4(stringOff + stringData.length);
  const codeOff = align4(typeListOff + typeList.length);
  const classData = Buffer.concat([
    uleb(0),
    uleb(0),
    uleb(1),
    uleb(0),
    uleb(1),
    uleb(1),
    uleb(codeOff),
  ]);
  const classDataOff = align4(codeOff + code.length);
  const dataEnd = classDataOff + classData.length;
  const fileSize = dataEnd;

  protoIds.writeUInt32LE(typeListOff, 8);
  for (let i = 0; i < strings.length; i++) {
    stringIds.writeUInt32LE(stringOff + stringIds.readUInt32LE(i * 4), i * 4);
  }

  const classDef = Buffer.alloc(32);
  classDef.writeUInt32LE(classDataOff, 24);

  const file = Buffer.alloc(fileSize);
  file.write("dex\n035\0", 0, "latin1");
  file.writeUInt32LE(fileSize, 0x20);
  file.writeUInt32LE(0x70, 0x24);
  file.writeUInt32LE(0x12345678, 0x28);
  file.writeUInt32LE(strings.length, 0x38);
  file.writeUInt32LE(headerSize, 0x3c);
  file.writeUInt32LE(2, 0x40);
  file.writeUInt32LE(headerSize + stringIds.length, 0x44);
  file.writeUInt32LE(2, 0x48);
  file.writeUInt32LE(headerSize + stringIds.length + typeIds.length, 0x4c);
  file.writeUInt32LE(3, 0x58);
  file.writeUInt32LE(headerSize + stringIds.length + typeIds.length + protoIds.length, 0x5c);
  file.writeUInt32LE(1, 0x60);
  file.writeUInt32LE(
    headerSize + stringIds.length + typeIds.length + protoIds.length + methodIds.length,
    0x64,
  );
  file.writeUInt32LE(fileSize - dataOff, 0x68);
  file.writeUInt32LE(dataOff, 0x6c);

  let at = headerSize;
  for (const part of [stringIds, typeIds, protoIds, methodIds, classDef]) {
    part.copy(file, at);
    at += part.length;
  }
  stringData.copy(file, stringOff);
  typeList.copy(file, typeListOff);
  code.copy(file, codeOff);
  classData.copy(file, classDataOff);

  const sha = createHash("sha1").update(file.subarray(32)).digest();
  sha.copy(file, 12);
  file.writeUInt32LE(adler32(file.subarray(12)), 8);
  return file;
}

/**
 * 在 {@link buildFixtureDex} 上多一个 `SystemClock.sleep(J)V`，
 * 并且方法体里有 idle 失败文案。改写器应把 `(JJ)V` 调用换成 sleep。
 */
function buildIdleDumpDex(): Buffer {
  const strings = [
    "J",
    "V",
    "VJJ",
    "other",
    "waitForIdle",
    "ERROR: could not get idle state.",
    "Landroid/os/SystemClock;",
    "sleep",
    "VJ",
  ];
  const stringData = Buffer.concat(strings.map(encodeMutf8));
  const stringIds = Buffer.alloc(strings.length * 4);
  let cursor = 0;
  for (let i = 0; i < strings.length; i++) {
    stringIds.writeUInt32LE(cursor, i * 4);
    cursor += 1 + (strings[i]?.length ?? 0) + 1;
  }

  // type 0 = V, type 1 = J, type 2 = SystemClock
  const typeIds = Buffer.alloc(12);
  typeIds.writeUInt32LE(1, 0);
  typeIds.writeUInt32LE(0, 4);
  typeIds.writeUInt32LE(6, 8);

  const typeListJj = Buffer.alloc(8);
  typeListJj.writeUInt32LE(2, 0);
  typeListJj.writeUInt16LE(1, 4);
  typeListJj.writeUInt16LE(1, 6);
  const typeListJ = Buffer.alloc(8);
  typeListJ.writeUInt32LE(1, 0);
  typeListJ.writeUInt16LE(1, 4);

  // proto 0 (JJ)V, proto 1 ()V, proto 2 (J)V
  const protoIds = Buffer.alloc(36);
  protoIds.writeUInt32LE(2, 0);
  protoIds.writeUInt32LE(0, 4);
  protoIds.writeUInt32LE(1, 12);
  protoIds.writeUInt32LE(0, 16);
  protoIds.writeUInt32LE(8, 24);
  protoIds.writeUInt32LE(0, 28);

  // 0 waitForIdle(JJ)V, 1 other()V, 2 waitForIdle()V, 3 SystemClock.sleep(J)V
  const methodIds = Buffer.alloc(32);
  methodIds.writeUInt16LE(0, 2);
  methodIds.writeUInt32LE(4, 4);
  methodIds.writeUInt16LE(1, 8);
  methodIds.writeUInt16LE(1, 10);
  methodIds.writeUInt32LE(3, 12);
  methodIds.writeUInt16LE(2, 16);
  methodIds.writeUInt16LE(1, 18);
  methodIds.writeUInt32LE(4, 20);
  methodIds.writeUInt16LE(2, 24);
  methodIds.writeUInt16LE(2, 26);
  methodIds.writeUInt32LE(7, 28);

  const insns = Buffer.concat([
    Buffer.from([0x1a, 0x00, 0x05, 0x00]),
    VOID_WAIT_INVOKE,
    OTHER_INVOKE,
    WAIT_INVOKE,
    Buffer.from([0x0e, 0x00]),
  ]);
  const code = Buffer.alloc(16 + insns.length);
  code.writeUInt16LE(5, 0);
  code.writeUInt16LE(5, 4);
  code.writeUInt32LE(insns.length / 2, 12);
  insns.copy(code, 16);

  const headerSize = 0x70;
  const idsSize =
    stringIds.length + typeIds.length + protoIds.length + methodIds.length + 32;
  const dataOff = align4(headerSize + idsSize);
  const stringOff = dataOff;
  const typeListJjOff = align4(stringOff + stringData.length);
  const typeListJOff = align4(typeListJjOff + typeListJj.length);
  const codeOff = align4(typeListJOff + typeListJ.length);
  const classData = Buffer.concat([
    uleb(0),
    uleb(0),
    uleb(1),
    uleb(0),
    uleb(1),
    uleb(1),
    uleb(codeOff),
  ]);
  const classDataOff = align4(codeOff + code.length);
  const fileSize = classDataOff + classData.length;

  protoIds.writeUInt32LE(typeListJjOff, 8);
  protoIds.writeUInt32LE(typeListJOff, 32);
  for (let i = 0; i < strings.length; i++) {
    stringIds.writeUInt32LE(stringOff + stringIds.readUInt32LE(i * 4), i * 4);
  }

  const classDef = Buffer.alloc(32);
  classDef.writeUInt32LE(classDataOff, 24);

  const file = Buffer.alloc(fileSize);
  file.write("dex\n035\0", 0, "latin1");
  file.writeUInt32LE(fileSize, 0x20);
  file.writeUInt32LE(0x70, 0x24);
  file.writeUInt32LE(0x12345678, 0x28);
  file.writeUInt32LE(strings.length, 0x38);
  file.writeUInt32LE(headerSize, 0x3c);
  file.writeUInt32LE(3, 0x40);
  file.writeUInt32LE(headerSize + stringIds.length, 0x44);
  file.writeUInt32LE(3, 0x48);
  file.writeUInt32LE(headerSize + stringIds.length + typeIds.length, 0x4c);
  file.writeUInt32LE(4, 0x58);
  file.writeUInt32LE(headerSize + stringIds.length + typeIds.length + protoIds.length, 0x5c);
  file.writeUInt32LE(1, 0x60);
  file.writeUInt32LE(
    headerSize + stringIds.length + typeIds.length + protoIds.length + methodIds.length,
    0x64,
  );
  file.writeUInt32LE(fileSize - dataOff, 0x68);
  file.writeUInt32LE(dataOff, 0x6c);

  let at = headerSize;
  for (const part of [stringIds, typeIds, protoIds, methodIds, classDef]) {
    part.copy(file, at);
    at += part.length;
  }
  stringData.copy(file, stringOff);
  typeListJj.copy(file, typeListJjOff);
  typeListJ.copy(file, typeListJOff);
  code.copy(file, codeOff);
  classData.copy(file, classDataOff);

  const sha = createHash("sha1").update(file.subarray(32)).digest();
  sha.copy(file, 12);
  file.writeUInt32LE(adler32(file.subarray(12)), 8);
  return file;
}

function encodeMutf8(text: string): Buffer {
  return Buffer.concat([uleb(text.length), Buffer.from(text, "utf8"), Buffer.from([0])]);
}

function uleb(n: number): Buffer {
  const bytes: number[] = [];
  let value = n;
  do {
    let b = value & 0x7f;
    value >>>= 7;
    if (value) {
      b |= 0x80;
    }
    bytes.push(b);
  } while (value);
  return Buffer.from(bytes);
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

function zipWithDeflatedDex(dex: Buffer): Buffer {
  const name = Buffer.from("classes.dex");
  const compressed = deflateRawSync(dex);
  const crc = crc32(dex);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(dex.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const offset = 0;
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(dex.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  name.copy(central, 46);
  const cdOff = local.length + compressed.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

function unzipDex(jar: Buffer): Buffer {
  const eocd = jar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOff = jar.readUInt32LE(eocd + 16);
  const localOff = jar.readUInt32LE(cdOff + 42);
  const nameLen = jar.readUInt16LE(localOff + 26);
  const extraLen = jar.readUInt16LE(localOff + 28);
  const method = jar.readUInt16LE(cdOff + 10);
  const compSize = jar.readUInt32LE(cdOff + 20);
  const dataOff = localOff + 30 + nameLen + extraLen;
  const compressed = jar.subarray(dataOff, dataOff + compSize);
  return method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}
