/**
 * 改写设备上 `uiautomator.jar` 里对 `UiAutomation.waitForIdle(long, long)` 的调用。
 *
 * 系统 `uiautomator dump` 在写出 XML 之前会 `waitForIdle(1000, 10000)`：界面持续
 * 刷新（视频、Lottie、倒计时）时 1000ms 静默永远等不到，10 秒后向 stderr 打印
 * `ERROR: could not get idle state.` 并直接返回，不写文件。
 *
 * 详情页这条调用改成 `SystemClock.sleep(静默时长)`：连接已经建立，固定等一小段
 * 让无障碍根节点出现，然后照常 `getRootInActiveWindow()`。整段 NOP 会在根节点
 * 还没挂上时就去取，得到 `null root node`。
 * 断开连接时的 `waitForIdle` 仍然 NOP，避免 dump 完又在忙碌界面上空等。
 * 指令长度不变，异常表和偏移都不用改，只重算 dex checksum / SHA-1。
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

/** 每条 dalvik opcode 的 code unit 数。0 表示未定义，遇到就放弃改写。 */
const INSN_UNITS = buildInsnUnits();

const INVOKE_OPCODES = new Set<number>([
  0x6e, 0x6f, 0x70, 0x71, 0x72, 0x74, 0x75, 0x76, 0x77, 0x78,
]);

/** DumpCommand 失败文案。含这句话的方法才是写出 XML 前的那次等待。 */
const IDLE_ERROR = "could not get idle state";

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 改写 jar（或裸 dex）。没有 `waitForIdle(JJ)V` 调用时抛错，调用方回落系统命令。 */
export function patchUiautomatorJar(input: Buffer): Buffer {
  if (input.length >= 8 && input.subarray(0, 4).toString("latin1") === "dex\n") {
    return patchUiautomatorDex(input);
  }
  const entries = readZip(input);
  let patched = 0;
  const out = entries.map((entry) => {
    if (!/^classes\d*\.dex$/.test(entry.name)) {
      return entry;
    }
    try {
      const data = patchUiautomatorDex(entry.data);
      patched += 1;
      return { name: entry.name, data };
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (/waitForIdle/.test(message)) {
        return entry;
      }
      throw exc;
    }
  });
  if (patched === 0) {
    throw new Error("uiautomator.jar 中没有可改写的 waitForIdle 调用");
  }
  return writeZip(out);
}

/** 改写一份 dex，返回新缓冲区（不修改入参）。 */
export function patchUiautomatorDex(input: Buffer): Buffer {
  const dex = Buffer.from(input);
  assertDexHeader(dex);
  const methodIds = findWaitForIdleMethodIds(dex);
  if (methodIds.size === 0) {
    throw new Error("dex 中没有 waitForIdle(long, long)");
  }
  const nops = nopInvokes(dex, methodIds);
  if (nops === 0) {
    throw new Error("没有找到 waitForIdle 调用");
  }
  refreshDexChecksums(dex);
  return dex;
}

function assertDexHeader(dex: Buffer): void {
  if (dex.length < 0x70) {
    throw new Error("dex 太短");
  }
  const magic = dex.subarray(0, 8).toString("latin1");
  if (!/^dex\n03[5789]\0$/.test(magic)) {
    throw new Error(`不支持的 dex 魔数: ${JSON.stringify(magic)}`);
  }
  if (dex.readUInt32LE(0x28) !== 0x12345678) {
    throw new Error("不支持的 dex 字节序");
  }
}

function findWaitForIdleMethodIds(dex: Buffer): Set<number> {
  const stringIdsOff = dex.readUInt32LE(0x3c);
  const typeIdsOff = dex.readUInt32LE(0x44);
  const protoIdsSize = dex.readUInt32LE(0x48);
  const protoIdsOff = dex.readUInt32LE(0x4c);
  const methodIdsSize = dex.readUInt32LE(0x58);
  const methodIdsOff = dex.readUInt32LE(0x5c);
  const ids = new Set<number>();
  for (let i = 0; i < methodIdsSize; i++) {
    const base = methodIdsOff + i * 8;
    const protoIdx = dex.readUInt16LE(base + 2);
    const nameIdx = dex.readUInt32LE(base + 4);
    if (readString(dex, stringIdsOff, nameIdx) !== "waitForIdle") {
      continue;
    }
    if (!isLongLongVoidProto(dex, protoIdsOff, protoIdsSize, typeIdsOff, stringIdsOff, protoIdx)) {
      continue;
    }
    ids.add(i);
  }
  return ids;
}

function isLongLongVoidProto(
  dex: Buffer,
  protoIdsOff: number,
  protoIdsSize: number,
  typeIdsOff: number,
  stringIdsOff: number,
  protoIdx: number,
): boolean {
  if (protoIdx >= protoIdsSize) {
    return false;
  }
  const base = protoIdsOff + protoIdx * 12;
  const returnTypeIdx = dex.readUInt32LE(base + 4);
  if (typeDescriptor(dex, typeIdsOff, stringIdsOff, returnTypeIdx) !== "V") {
    return false;
  }
  const paramsOff = dex.readUInt32LE(base + 8);
  if (paramsOff === 0) {
    return false;
  }
  const size = dex.readUInt32LE(paramsOff);
  if (size !== 2) {
    return false;
  }
  const t0 = dex.readUInt16LE(paramsOff + 4);
  const t1 = dex.readUInt16LE(paramsOff + 6);
  return (
    typeDescriptor(dex, typeIdsOff, stringIdsOff, t0) === "J" &&
    typeDescriptor(dex, typeIdsOff, stringIdsOff, t1) === "J"
  );
}

function typeDescriptor(
  dex: Buffer,
  typeIdsOff: number,
  stringIdsOff: number,
  typeIdx: number,
): string {
  const stringIdx = dex.readUInt32LE(typeIdsOff + typeIdx * 4);
  return readString(dex, stringIdsOff, stringIdx);
}

function readString(dex: Buffer, stringIdsOff: number, stringIdx: number): string {
  const dataOff = dex.readUInt32LE(stringIdsOff + stringIdx * 4);
  const { next } = readUleb(dex, dataOff);
  const end = dex.indexOf(0, next);
  if (end < 0) {
    throw new Error("dex 字符串没有结尾 0");
  }
  return dex.toString("utf8", next, end);
}

function findSystemClockSleepId(dex: Buffer): number | null {
  const stringIdsOff = dex.readUInt32LE(0x3c);
  const typeIdsOff = dex.readUInt32LE(0x44);
  const protoIdsSize = dex.readUInt32LE(0x48);
  const protoIdsOff = dex.readUInt32LE(0x4c);
  const methodIdsSize = dex.readUInt32LE(0x58);
  const methodIdsOff = dex.readUInt32LE(0x5c);
  for (let i = 0; i < methodIdsSize; i++) {
    const base = methodIdsOff + i * 8;
    const classIdx = dex.readUInt16LE(base);
    const protoIdx = dex.readUInt16LE(base + 2);
    const nameIdx = dex.readUInt32LE(base + 4);
    if (readString(dex, stringIdsOff, nameIdx) !== "sleep") {
      continue;
    }
    if (typeDescriptor(dex, typeIdsOff, stringIdsOff, classIdx) !== "Landroid/os/SystemClock;") {
      continue;
    }
    if (!isLongVoidProto(dex, protoIdsOff, protoIdsSize, typeIdsOff, stringIdsOff, protoIdx)) {
      continue;
    }
    return i;
  }
  return null;
}

function isLongVoidProto(
  dex: Buffer,
  protoIdsOff: number,
  protoIdsSize: number,
  typeIdsOff: number,
  stringIdsOff: number,
  protoIdx: number,
): boolean {
  if (protoIdx >= protoIdsSize) {
    return false;
  }
  const base = protoIdsOff + protoIdx * 12;
  const returnTypeIdx = dex.readUInt32LE(base + 4);
  if (typeDescriptor(dex, typeIdsOff, stringIdsOff, returnTypeIdx) !== "V") {
    return false;
  }
  const paramsOff = dex.readUInt32LE(base + 8);
  if (paramsOff === 0) {
    return false;
  }
  const size = dex.readUInt32LE(paramsOff);
  if (size !== 1) {
    return false;
  }
  const t0 = dex.readUInt16LE(paramsOff + 4);
  return typeDescriptor(dex, typeIdsOff, stringIdsOff, t0) === "J";
}

function nopInvokes(dex: Buffer, methodIds: Set<number>): number {
  const classDefsSize = dex.readUInt32LE(0x60);
  const classDefsOff = dex.readUInt32LE(0x64);
  const sleepId = findSystemClockSleepId(dex);
  let nops = 0;
  for (let i = 0; i < classDefsSize; i++) {
    const classDataOff = dex.readUInt32LE(classDefsOff + i * 32 + 24);
    if (classDataOff === 0) {
      continue;
    }
    for (const codeOff of methodCodeOffs(dex, classDataOff)) {
      nops += nopInvokesInCode(dex, codeOff, methodIds, sleepId);
    }
  }
  return nops;
}

function methodCodeOffs(dex: Buffer, classDataOff: number): number[] {
  let pos = classDataOff;
  const staticFields = readUleb(dex, pos);
  pos = staticFields.next;
  const instanceFields = readUleb(dex, pos);
  pos = instanceFields.next;
  const directMethods = readUleb(dex, pos);
  pos = directMethods.next;
  const virtualMethods = readUleb(dex, pos);
  pos = virtualMethods.next;
  pos = skipEncodedFields(dex, pos, staticFields.value + instanceFields.value);
  const offs: number[] = [];
  const methodCount = directMethods.value + virtualMethods.value;
  for (let i = 0; i < methodCount; i++) {
    const idx = readUleb(dex, pos);
    pos = idx.next;
    const flags = readUleb(dex, pos);
    pos = flags.next;
    const code = readUleb(dex, pos);
    pos = code.next;
    if (code.value !== 0) {
      offs.push(code.value);
    }
  }
  return offs;
}

function skipEncodedFields(dex: Buffer, pos: number, count: number): number {
  for (let i = 0; i < count; i++) {
    pos = readUleb(dex, pos).next;
    pos = readUleb(dex, pos).next;
  }
  return pos;
}

function nopInvokesInCode(
  dex: Buffer,
  codeOff: number,
  methodIds: Set<number>,
  sleepId: number | null,
): number {
  try {
    const toSleep = sleepId !== null && methodMentionsIdleError(dex, codeOff);
    return nopInvokesByWalk(dex, codeOff, methodIds, toSleep ? sleepId : null);
  } catch {
    // 个别方法的指令宽度对不上时，按 code unit 对齐搜调用点，避免整份 jar 放弃。
    return nopInvokesByScan(dex, codeOff, methodIds);
  }
}

/** 这个方法是否会在等不到静默时打印 `could not get idle state`。 */
function methodMentionsIdleError(dex: Buffer, codeOff: number): boolean {
  const stringIdsOff = dex.readUInt32LE(0x3c);
  const insnsSize = dex.readUInt32LE(codeOff + 12);
  const insnsOff = codeOff + 16;
  const end = insnsOff + insnsSize * 2;
  let pos = insnsOff;
  while (pos < end) {
    const unit = dex.readUInt16LE(pos);
    if (unit === 0x0100 || unit === 0x0200 || unit === 0x0300) {
      const units = payloadUnits(dex, pos);
      if (units <= 0 || pos + units * 2 > end) {
        return false;
      }
      pos += units * 2;
      continue;
    }
    const opcode = unit & 0xff;
    const width = INSN_UNITS[opcode] ?? 0;
    if (width === 0 || pos + width * 2 > end) {
      return false;
    }
    let stringIdx: number | null = null;
    if (opcode === 0x1a) {
      stringIdx = dex.readUInt16LE(pos + 2);
    } else if (opcode === 0x1b) {
      stringIdx = dex.readUInt32LE(pos + 2);
    }
    if (stringIdx !== null && readString(dex, stringIdsOff, stringIdx).includes(IDLE_ERROR)) {
      return true;
    }
    pos += width * 2;
  }
  return false;
}

function nopInvokesByWalk(
  dex: Buffer,
  codeOff: number,
  methodIds: Set<number>,
  sleepId: number | null,
): number {
  const insnsSize = dex.readUInt32LE(codeOff + 12);
  const insnsOff = codeOff + 16;
  const end = insnsOff + insnsSize * 2;
  let pos = insnsOff;
  let nops = 0;
  while (pos < end) {
    const unit = dex.readUInt16LE(pos);
    if (unit === 0x0100 || unit === 0x0200 || unit === 0x0300) {
      const units = payloadUnits(dex, pos);
      if (units <= 0 || pos + units * 2 > end) {
        throw new Error("坏的 switch/array payload");
      }
      pos += units * 2;
      continue;
    }
    const opcode = unit & 0xff;
    const width = INSN_UNITS[opcode] ?? 0;
    if (width === 0) {
      throw new Error(`未知 opcode 0x${opcode.toString(16)}，放弃改写 dex`);
    }
    if (pos + width * 2 > end) {
      throw new Error("指令越过方法结尾");
    }
    if (INVOKE_OPCODES.has(opcode) && methodIds.has(dex.readUInt16LE(pos + 2))) {
      if (sleepId === null || !writeSleepInvoke(dex, pos, opcode, sleepId)) {
        dex.writeUInt16LE(0, pos);
        dex.writeUInt16LE(0, pos + 2);
        dex.writeUInt16LE(0, pos + 4);
      }
      nops += 1;
    }
    pos += width * 2;
  }
  if (pos !== end) {
    throw new Error("指令流没有在方法结尾对齐");
  }
  return nops;
}

/**
 * 把 `waitForIdle(this, quiet, global)` 换成 `SystemClock.sleep(quiet)`。
 * quiet 是第一个 long，占一对寄存器。写不进去时返回 false，调用方改 NOP。
 */
function writeSleepInvoke(dex: Buffer, pos: number, opcode: number, sleepId: number): boolean {
  const pair = idleQuietRegisters(dex, pos, opcode);
  if (pair === null) {
    return false;
  }
  const [low, high] = pair;
  if (low <= 15 && high <= 15) {
    // 35c: A=2, G=0, 寄存器对是第一个 long（静默时长），不是 this。
    dex.writeUInt16LE((2 << 12) | 0x71, pos);
    dex.writeUInt16LE(sleepId, pos + 2);
    dex.writeUInt16LE((high << 4) | low, pos + 4);
    return true;
  }
  dex.writeUInt8(0x77, pos);
  dex.writeUInt8(2, pos + 1);
  dex.writeUInt16LE(sleepId, pos + 2);
  dex.writeUInt16LE(low, pos + 4);
  return true;
}

/** `waitForIdle` 的第一个 long（静默时长）所在的寄存器对。 */
function idleQuietRegisters(dex: Buffer, pos: number, opcode: number): [number, number] | null {
  if (opcode >= 0x74) {
    const count = dex.readUInt8(pos + 1);
    const first = dex.readUInt16LE(pos + 4);
    if (count !== 5) {
      return null;
    }
    return evenPair(first + 1, first + 2);
  }
  const unit0 = dex.readUInt16LE(pos);
  // 35c 的高字节是 A|G：高半字节是参数个数，低半字节是第 5 个寄存器。
  const count = (unit0 >> 12) & 0xf;
  const fifth = (unit0 >> 8) & 0xf;
  const unit2 = dex.readUInt16LE(pos + 4);
  const regs = [
    unit2 & 0xf,
    (unit2 >> 4) & 0xf,
    (unit2 >> 8) & 0xf,
    (unit2 >> 12) & 0xf,
    fifth,
  ];
  if (count !== 5) {
    return null;
  }
  return evenPair(regs[1] ?? -1, regs[2] ?? -1);
}

function evenPair(low: number, high: number): [number, number] | null {
  if (low < 0 || low % 2 !== 0 || high !== low + 1) {
    return null;
  }
  return [low, high];
}

function nopInvokesByScan(dex: Buffer, codeOff: number, methodIds: Set<number>): number {
  const insnsSize = dex.readUInt32LE(codeOff + 12);
  const insnsOff = codeOff + 16;
  const end = insnsOff + insnsSize * 2;
  let nops = 0;
  for (let pos = insnsOff; pos + 6 <= end; pos += 2) {
    const opcode = dex.readUInt16LE(pos) & 0xff;
    if (!INVOKE_OPCODES.has(opcode) || !methodIds.has(dex.readUInt16LE(pos + 2))) {
      continue;
    }
    dex.writeUInt16LE(0, pos);
    dex.writeUInt16LE(0, pos + 2);
    dex.writeUInt16LE(0, pos + 4);
    nops += 1;
    pos += 4;
  }
  return nops;
}

function payloadUnits(dex: Buffer, pos: number): number {
  const ident = dex.readUInt16LE(pos);
  if (ident === 0x0100) {
    return 4 + dex.readUInt16LE(pos + 2) * 2;
  }
  if (ident === 0x0200) {
    return 2 + dex.readUInt16LE(pos + 2) * 4;
  }
  if (ident === 0x0300) {
    const elementWidth = dex.readUInt16LE(pos + 2);
    const size = dex.readUInt32LE(pos + 4);
    return 4 + Math.ceil((elementWidth * size) / 2);
  }
  return 0;
}

function refreshDexChecksums(dex: Buffer): void {
  const sha = createHash("sha1").update(dex.subarray(32)).digest();
  sha.copy(dex, 12);
  dex.writeUInt32LE(adler32(dex.subarray(12)) >>> 0, 8);
}

function readUleb(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (shift <= 28) {
    const b = buf[pos];
    if (b === undefined) {
      throw new Error("uleb128 越过缓冲区");
    }
    pos += 1;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7;
  }
  throw new Error("uleb128 过长");
}

function readZip(input: Buffer): ZipEntry[] {
  const eocd = findEocd(input);
  const count = input.readUInt16LE(eocd + 10);
  const cdOff = input.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let pos = cdOff;
  for (let i = 0; i < count; i++) {
    if (input.readUInt32LE(pos) !== ZIP_CENTRAL) {
      throw new Error("zip 中央目录损坏");
    }
    const method = input.readUInt16LE(pos + 10);
    const compSize = input.readUInt32LE(pos + 20);
    const nameLen = input.readUInt16LE(pos + 28);
    const extraLen = input.readUInt16LE(pos + 30);
    const commentLen = input.readUInt16LE(pos + 32);
    const localOff = input.readUInt32LE(pos + 42);
    const name = input.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (input.readUInt32LE(localOff) !== ZIP_LOCAL) {
      throw new Error(`zip 本地头损坏: ${name}`);
    }
    const localNameLen = input.readUInt16LE(localOff + 26);
    const localExtraLen = input.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = input.subarray(dataOff, dataOff + compSize);
    const data = inflateEntry(method, compressed);
    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(method: number, compressed: Buffer): Buffer {
  if (method === 0) {
    return Buffer.from(compressed);
  }
  if (method === 8) {
    return inflateRawSync(compressed);
  }
  throw new Error(`不支持的 zip 压缩方法: ${method}`);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) {
      return i;
    }
  }
  throw new Error("不是 zip");
}

function writeZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(ZIP_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, entry.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(ZIP_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

/** ZIP / dex 用的 CRC-32（ISO-HDLC）。 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k++) {
      const mask = -(c & 1);
      c = (c >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (~c) >>> 0;
}

/** dex header 用的 Adler-32。 */
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

function buildInsnUnits(): Uint8Array {
  const w = new Uint8Array(256);
  const fill = (from: number, to: number, width: number): void => {
    for (let op = from; op <= to; op++) {
      w[op] = width;
    }
  };
  const one: number[] = [
    0x00, 0x01, 0x04, 0x07, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x1d, 0x1e,
    0x21, 0x27, 0x28,
  ];
  for (const op of one) {
    w[op] = 1;
  }
  fill(0x7b, 0x91, 1);
  fill(0xb2, 0xd1, 1);
  const two = [
    0x02, 0x05, 0x08, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x1f, 0x20, 0x22, 0x23, 0x29,
  ];
  for (const op of two) {
    w[op] = 2;
  }
  fill(0x2d, 0x3d, 2);
  fill(0x44, 0x6d, 2);
  fill(0x92, 0xaf, 2);
  fill(0xd2, 0xe4, 2);
  w[0xfe] = 2;
  w[0xff] = 2;
  const three = [0x03, 0x06, 0x09, 0x14, 0x17, 0x1b, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2c];
  for (const op of three) {
    w[op] = 3;
  }
  fill(0x6e, 0x72, 3);
  fill(0x74, 0x78, 3);
  w[0xfc] = 3;
  w[0xfd] = 3;
  w[0xfa] = 4;
  w[0xfb] = 4;
  w[0x18] = 5;
  return w;
}
