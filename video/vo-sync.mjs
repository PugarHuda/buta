/**
 * Fit the video to the narration, instead of the other way round.
 *
 *   node video/vo-sync.mjs
 *
 * Drop one audio file per beat in video/vo/ named 01.wav, 02.wav and so on, in
 * the order of BEATS in src/script.ts. This measures each one and writes
 * src/vo.json, which script.ts uses in place of the hand-set `seconds`.
 *
 * Why per beat rather than one long track: a single file forces every beat to
 * match a number typed by hand, and a reading that runs two seconds long on
 * beat three pushes every later subtitle out of step with its own picture. Per
 * beat, each shot is exactly as long as the sentence describing it, and a
 * retake of one line costs one file.
 *
 * A little air is added to each beat so a cut does not land on the last
 * syllable.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMedia } from "@remotion/media-parser";
import { nodeReader } from "@remotion/media-parser/node";

const here = fileURLToPath(new URL("./", import.meta.url));
const voDir = path.join(here, "vo");
const outPath = path.join(here, "src", "vo.json");

/** Breathing room after each line, in seconds. */
const TAIL = 0.65;

if (!fs.existsSync(voDir)) {
  console.error(`no ${voDir}. Put one file per beat in there: 01.wav, 02.wav, ...`);
  process.exit(2);
}

const files = fs
  .readdirSync(voDir)
  .filter((f) => /^\d+\.(wav|mp3|m4a|aac|ogg)$/i.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

if (!files.length) {
  console.error(`nothing in ${voDir} named like 01.wav`);
  process.exit(2);
}

const beats = [];
for (const f of files) {
  const { slowDurationInSeconds } = await parseMedia({
    src: path.join(voDir, f),
    fields: { slowDurationInSeconds: true },
    reader: nodeReader,
  });
  const seconds = Number(slowDurationInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(`could not read a duration from ${f}`);
    process.exit(1);
  }
  beats.push({ file: f, seconds: Math.round((seconds + TAIL) * 100) / 100 });
  console.log(`  ${f.padEnd(8)} ${seconds.toFixed(2)}s  ->  beat ${(seconds + TAIL).toFixed(2)}s`);
}

fs.writeFileSync(outPath, JSON.stringify({ tail: TAIL, beats }, null, 2));
const total = beats.reduce((a, b) => a + b.seconds, 0);
console.log(`\n${beats.length} beats, ${Math.floor(total / 60)}m ${Math.round(total % 60)}s total`);
console.log(`wrote ${path.relative(here, outPath)}`);
console.log("now render: npx remotion render src/index.ts DemoVoiced out/voiced.mp4");
