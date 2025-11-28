const fs = require("fs");
const { tmpdir } = require("os");
const Crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const webp = require("node-webpmux");
const path = require("path");

// 💠 Generate temp path
const tempFile = (ext) =>
  path.join(tmpdir(), `${Crypto.randomBytes(8).toString("hex")}.${ext}`);

// 💠 Ensure file is fully written (Heroku fix)
function ensureValid(file) {
  if (!fs.existsSync(file)) throw new Error("Temp file missing");
  const size = fs.statSync(file).size;
  if (size < 1000) throw new Error("Corrupted output (Heroku truncated file)");
}

// ==========================================================
// 🔵 IMAGE → WEBP
// ==========================================================
async function imageToWebp(buffer) {
  const input = tempFile("jpg");
  const output = tempFile("webp");

  fs.writeFileSync(input, buffer);

  await new Promise((resolve, reject) => {
    ffmpeg(input)
      .on("error", reject)
      .on("end", resolve)
      .addOutputOptions([
        "-vcodec", "libwebp",
        "-vf",
          "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease," +
          "fps=15,pad=320:320:-1:-1:color=white@0.0",
      ])
      .toFormat("webp")
      .save(output);
  });

  ensureValid(output);

  const result = fs.readFileSync(output);
  fs.unlinkSync(input);
  fs.unlinkSync(output);
  return result;
}

// ==========================================================
// 🔵 VIDEO → WEBP
// ==========================================================
async function videoToWebp(buffer) {
  const input = tempFile("mp4");
  const output = tempFile("webp");

  fs.writeFileSync(input, buffer);

  await new Promise((resolve, reject) => {
    ffmpeg(input)
      .on("error", reject)
      .on("end", resolve)
      .addOutputOptions([
        "-vcodec", "libwebp",
        "-vf",
          "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease," +
          "fps=15,pad=320:320:-1:-1:color=white@0.0",
        "-loop", "0",
        "-preset", "default",
        "-an",
      ])
      .toFormat("webp")
      .save(output);
  });

  ensureValid(output);

  const result = fs.readFileSync(output);
  fs.unlinkSync(input);
  fs.unlinkSync(output);
  return result;
}

// ==========================================================
// 🔵 Create EXIF Buffer
// ==========================================================
function makeExif({ packname = "", author = "", categories = [""] }) {
  const json = {
    "sticker-pack-id": Crypto.randomBytes(8).toString("hex"),
    "sticker-pack-name": packname,
    "sticker-pack-publisher": author,
    "emojis": categories,
  };

  const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2A, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x16, 0x00, 0x00, 0x00,
  ]);

  exifAttr.writeUIntLE(jsonBuff.length, 14, 4);

  return Buffer.concat([exifAttr, jsonBuff]);
}

// ==========================================================
// 🔵 Write EXIF to WEBP (image or video)
// ==========================================================
async function writeExifBuffer(webpBuffer, metadata) {
  const exif = makeExif(metadata);

  const img = new webp.Image();
  await img.load(webpBuffer);
  img.exif = exif;

  return await img.save(null); // return buffer
}

// ==========================================================
// 🔵 Auto Detect & Process EXIF
// ==========================================================
async function writeExifAuto(buffer, mime, metadata) {
  let webpBuf;

  if (mime.includes("webp")) {
    webpBuf = buffer;
  } else if (mime.includes("image")) {
    webpBuf = await imageToWebp(buffer);
  } else if (mime.includes("video")) {
    webpBuf = await videoToWebp(buffer);
  } else {
    throw new Error("Unsupported media type for EXIF");
  }

  return await writeExifBuffer(webpBuf, metadata);
}

// EXPORTS
module.exports = {
  imageToWebp,
  videoToWebp,
  writeExifBuffer,
  writeExifAuto,
};
