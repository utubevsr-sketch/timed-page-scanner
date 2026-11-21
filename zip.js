const crcTable = Uint32Array.from({ length: 256 }, (_value, index) => {
  let remainder = index;
  for (let bit = 0; bit < 8; bit += 1) {
    remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
  }
  return remainder >>> 0;
});

async function crc32(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, checksum, size, date, time) {
  const bytes = new Uint8Array(30 + name.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x04034b50, true);
  header.setUint16(4, 20, true);
  header.setUint16(10, time, true);
  header.setUint16(12, date, true);
  header.setUint32(14, checksum, true);
  header.setUint32(18, size, true);
  header.setUint32(22, size, true);
  header.setUint16(26, name.length, true);
  bytes.set(name, 30);
  return bytes;
}

function directoryHeader(name, checksum, size, date, time, offset) {
  const bytes = new Uint8Array(46 + name.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x02014b50, true);
  header.setUint16(4, 20, true);
  header.setUint16(6, 20, true);
  header.setUint16(12, time, true);
  header.setUint16(14, date, true);
  header.setUint32(16, checksum, true);
  header.setUint32(20, size, true);
  header.setUint32(24, size, true);
  header.setUint16(28, name.length, true);
  header.setUint32(42, offset, true);
  bytes.set(name, 46);
  return bytes;
}

export async function makeZip(count, loadPhoto) {
  const parts = [];
  const directory = [];
  const encoder = new TextEncoder();
  const now = new Date();
  const year = Math.max(1980, Math.min(2107, now.getFullYear()));
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  let offset = 0;
  let directorySize = 0;

  if (count < 1 || count > 999) throw new Error("This ZIP can contain 1 to 999 photos.");
  for (let number = 1; number <= count; number += 1) {
    const photo = await loadPhoto(number);
    const name = encoder.encode(`page-${String(number).padStart(3, "0")}.jpg`);
    const checksum = await crc32(photo);
    if (offset + photo.size + 30 + name.length > 0xffffffff) throw new Error("The photos are too large for one ZIP.");
    const local = localHeader(name, checksum, photo.size, date, time);
    const entry = directoryHeader(name, checksum, photo.size, date, time, offset);
    // JPEGs are already compressed. Keep the on-disk Blob references and read one at a time for CRCs.
    parts.push(local, photo);
    directory.push(entry);
    offset += local.length + photo.size;
    directorySize += entry.length;
  }

  const end = new Uint8Array(22);
  const header = new DataView(end.buffer);
  header.setUint32(0, 0x06054b50, true);
  header.setUint16(8, count, true);
  header.setUint16(10, count, true);
  header.setUint32(12, directorySize, true);
  header.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}
