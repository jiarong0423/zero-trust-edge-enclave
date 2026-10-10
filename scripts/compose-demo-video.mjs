#!/usr/bin/env node
// Puts two screen recordings, the computer window and the phone, into one side-by-side video. The two were started by hand at different
// moments, so they are lined up by the demo's own countdown: it is a dark card on both screens and ends at the same instant, and the
// first light frame after it is found in each recording. No sound is added.
//
//   node scripts/compose-demo-video.mjs --mac mac.mov --phone phone.mp4 --out demo.mp4 [--mac-crop x:y:w:h] [--seconds 171]
//   --mac-crop  keep only this part of the computer recording (pixels of the recording), when more than the demo window was captured; the
//               countdown is also looked for inside it, so a full-screen recording works if this box is given
//   --seconds   how much to keep after the sync point (default: the storyboard's length, at most 180)
// Needs ffmpeg and ffprobe.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CANVAS = { width: 1920, height: 1080 };
const FPS = 30;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });

export function parseArgs(argv) {
  const options = { crop: null, seconds: 171 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i], value = argv[i + 1];
    if (key === '--mac') options.mac = value, i += 1;
    else if (key === '--phone') options.phone = value, i += 1;
    else if (key === '--out') options.out = value, i += 1;
    else if (key === '--mac-crop') options.crop = value, i += 1;
    else if (key === '--seconds') options.seconds = Number(value), i += 1;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!options.mac || !options.phone || !options.out) throw new Error('--mac, --phone and --out are required');
  if (options.crop && !/^\d+:\d+:\d+:\d+$/.test(options.crop)) throw new Error('--mac-crop must be x:y:w:h in pixels');
  if (!Number.isFinite(options.seconds) || options.seconds < 5 || options.seconds > 180) throw new Error('--seconds must be between 5 and 180');
  return options;
}

// Mean brightness (0-255) of each frame, at a low rate: enough to see a dark card end.
export function brightness(file, { fps = 10, seconds = 90, crop = null } = {}) {
  const cut = crop ? `crop=${crop.split(':')[2]}:${crop.split(':')[3]}:${crop.split(':')[0]}:${crop.split(':')[1]},` : '';
  const text = run('ffmpeg', ['-v', 'error', '-t', String(seconds), '-i', file, '-vf', `${cut}fps=${fps},scale=64:-1,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-an', '-f', 'null', '-']);
  return [...text.matchAll(/pts_time:([\d.]+)[\s\S]*?YAVG=([\d.]+)/g)].map(m => ({ t: Number(m[1]), y: Number(m[2]) }));
}

// The sync point: the first moment the picture becomes light after having been dark (the countdown card is dark, the pages are light).
export function findSync(samples, { dark = 70, light = 110, minDark = 1.0 } = {}) {
  let darkSince = null;
  for (const { t, y } of samples) {
    if (y < dark) { if (darkSince === null) darkSince = t; }
    else if (y > light && darkSince !== null && t - darkSince >= minDark) return t;
  }
  return null;
}

export function filterGraph({ crop, seconds }) {
  const mac = `[0:v]${crop ? `crop=${crop.split(':')[2]}:${crop.split(':')[3]}:${crop.split(':')[0]}:${crop.split(':')[1]},` : ''}scale=1380:-2,setsar=1[m]`;
  const phone = `[1:v]scale=-2:1020,setsar=1[p]`;
  return `${mac};${phone};color=c=0x0e1f1b:s=${CANVAS.width}x${CANVAS.height}:r=${FPS}:d=${seconds}[bg];[bg][m]overlay=40:(H-h)/2[a];[a][p]overlay=W-w-60:(H-h)/2:shortest=1[v]`;
}

export async function compose(options) {
  for (const file of [options.mac, options.phone]) await fs.access(file);
  const macSync = findSync(brightness(options.mac, { crop: options.crop }));
  const phoneSync = findSync(brightness(options.phone));
  if (macSync === null || phoneSync === null) throw new Error(`could not find the countdown's end in the ${macSync === null ? 'computer' : 'phone'} recording (it must show the dark countdown card, then the demo)`);
  const seconds = options.seconds;
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(macSync), '-t', String(seconds), '-i', options.mac, '-ss', String(phoneSync), '-t', String(seconds), '-i', options.phone,
    '-filter_complex', filterGraph({ crop: options.crop, seconds }), '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-t', String(seconds), options.out]);
  const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', options.out]).trim());
  return { macSync, phoneSync, duration };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await compose(parseArgs(process.argv.slice(2)));
    process.stdout.write(`composed ${result.duration.toFixed(1)} s (the computer recording was lined up at ${result.macSync.toFixed(1)} s, the phone at ${result.phoneSync.toFixed(1)} s)\n`);
  } catch (error) { process.stderr.write(`ERROR ${error.message}\n`); process.exit(1); }
}
