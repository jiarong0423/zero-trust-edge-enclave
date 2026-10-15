#!/usr/bin/env node
// Puts two screen recordings, the computer window and the phone, into one video: the computer fills the whole picture and the phone sits on
// top of it as a small inset at the right edge. The two were started by hand at different moments, so they are lined up by the demo's own
// countdown: it is a dark card on both screens and ends at the same instant, and the first light frame after it is found in each recording.
// No sound is added.
//
// Recording (both by hand, both started before the countdown ends and stopped after the end card):
//   computer  screencapture -v -C -R0,0,<W>,<H> mac.mov     (the choreography prints W and H; -C keeps the pointer in the picture)
//   phone     the phone's built-in screen recorder, started by the person during the demo's dark countdown (adb screenrecord stops at 180 s,
//             so it cannot cover countdown plus demo, and this phone has no screenrecord binary anyway)
// The countdown is searched for in the first 600 s of each recording (a low-rate brightness scan, cheap), so a recording may start up to about 8 minutes before the demo.
//
//   node scripts/compose-demo-video.mjs --mac mac.mov --phone phone.mp4 --out demo.mp4 [--intro picture.png] [--mac-crop x:y:w:h] [--phone-crop x:y:w:h] [--focus-phone start:end] [--hide-inset start:end] [--seconds 174]
// Layout (1920x1080): the computer recording is scaled to fill the whole picture (the page text stays as large as the recording allows, no black bands).
//   The phone is an inset 700 px high, 20 px from the right edge, its top at y=100, with a thin mint outline; the bottom 120 px stay clear for the
//   demo's captions. With --focus-phone the phone is shown large (880 px high, centred, top at y=40) for that window: the computer picture above the
//   caption strip (y 0-960) is darkened to 45 % brightness, the inset is cut, and the change fades in and out over 0.4 s.
//   --mac-crop    keep only this part of the computer recording (pixels of the recording), when more than the demo window was captured; the
//                 countdown is also looked for inside it, so a full-screen recording works if this box is given
//   --phone-crop  keep only this part of the phone recording, to cut the Android status bar and navigation bar; the values (pixels of the
//                 recording) are read off a frame of the real phone recording, they are not guessed
//   --hide-inset start:end   cut the small phone inset for that window (seconds after the sync point), e.g. over the end cards, where it would cover the
//               computer's text; the phone is not shown at all then
//   --focus-phone start:end, in seconds after the sync point (e.g. 101:146, the scenes that happen on the phone); end is at least 2 s after start and
//                 not above --seconds. Without it the phone stays a small inset for the whole video.
//   --min-dark  how many seconds the picture must stay dark to be taken for the countdown (default 10; the demo's countdown is 20 s or more and macOS
//               shows a second or two of black when it enters full screen); lower it only for a recording of a shorter countdown
//   --seconds     how much to keep after the sync point (default 174: the demo plays about 172 s after the countdown and the limit of
//                 3 minutes is a hard ceiling, so anything above 178 is refused)
//   --intro       a picture laid over the first --intro-seconds (default 6), fading in and out; the demo keeps playing under it, so the length does not
//                 change. It covers the canvas except the bottom --intro-keep pixels (default 230), where the demo's captions are.
// Needs ffmpeg and ffprobe.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CANVAS = { width: 1920, height: 1080 };
const FPS = 30;
// The countdown card is dark for the whole countdown (20 s or more). A shorter dark spell, such as the black frames while macOS enters full screen, is not the
// countdown, so a spell has to last this long to count; a recording of a shorter countdown needs --min-dark lowered.
const DEFAULT_MIN_DARK = 10;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });

export function parseArgs(argv) {
  const options = { crop: null, seconds: 174, phoneCrop: null, intro: null, introSeconds: 6, introKeep: 130, minDark: DEFAULT_MIN_DARK, focus: null, hideInset: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i], value = argv[i + 1];
    if (key === '--mac') options.mac = value, i += 1;
    else if (key === '--phone') options.phone = value, i += 1;
    else if (key === '--out') options.out = value, i += 1;
    else if (key === '--mac-crop') options.crop = value, i += 1;
    else if (key === '--phone-crop') options.phoneCrop = value, i += 1;
    else if (key === '--focus-phone') options.focus = parseFocus(value, '--focus-phone'), i += 1;
    else if (key === '--hide-inset') options.hideInset = parseFocus(value, '--hide-inset'), i += 1;
    else if (key === '--min-dark') options.minDark = Number(value), i += 1;
    else if (key === '--seconds') options.seconds = Number(value), i += 1;
    else if (key === '--intro') options.intro = value, i += 1;
    else if (key === '--intro-seconds') options.introSeconds = Number(value), i += 1;
    else if (key === '--intro-keep') options.introKeep = Number(value), i += 1;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!options.mac || !options.phone || !options.out) throw new Error('--mac, --phone and --out are required');
  if (options.crop && !/^\d+:\d+:\d+:\d+$/.test(options.crop)) throw new Error('--mac-crop must be x:y:w:h in pixels');
  if (!Number.isFinite(options.minDark) || options.minDark < 1 || options.minDark > 60) throw new Error('--min-dark must be between 1 and 60 seconds');
  if (options.phoneCrop && !/^\d+:\d+:\d+:\d+$/.test(options.phoneCrop)) throw new Error('--phone-crop must be x:y:w:h in pixels');
  if (!Number.isFinite(options.seconds) || options.seconds < 5 || options.seconds > 178) throw new Error('--seconds must be between 5 and 178 (the video must stay under 3 minutes)');
  if (!Number.isFinite(options.introSeconds) || options.introSeconds < 1 || options.introSeconds > 15) throw new Error('--intro-seconds must be between 1 and 15');
  if (!Number.isFinite(options.introKeep) || options.introKeep < 0 || options.introKeep > 400) throw new Error('--intro-keep must be between 0 and 400');
  checkFocus(options.focus, options.seconds);
  checkFocus(options.hideInset, options.seconds, '--hide-inset');
  return options;
}

// "start:end" in seconds after the sync point, two non-negative numbers.
function parseFocus(value, name = '--focus-phone') {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value ?? '');
  if (!match) throw new Error(`${name} must be start:end in seconds, two non-negative numbers (e.g. 101:146)`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function checkFocus(focus, seconds, name = '--focus-phone') {
  if (!focus) return;
  if (!(focus.end - focus.start >= 2)) throw new Error(`${name}: end must be at least 2 seconds after start`);
  if (focus.end > seconds) throw new Error(`${name}: end (${focus.end}) must not be above --seconds (${seconds})`);
}

// Mean brightness (0-255) of each frame, at a low rate: enough to see a dark card end.
export function brightness(file, { fps = 10, seconds = 600, crop = null } = {}) {
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

const cropFilter = crop => crop ? `crop=${crop.split(':')[2]}:${crop.split(':')[3]}:${crop.split(':')[0]}:${crop.split(':')[1]},` : '';
// The phone is shown in two sizes with the same thin outline (the outline is added around the picture, so the boxes are OUTLINE px taller and wider).
// Inset: always there, at the right edge, clear of the caption strip at the bottom. Large: only during --focus-phone, centred, above the strip.
const SMALL = { height: 700, right: 20, top: 100 };
const LARGE = { height: 880, top: 40 };
const OUTLINE = 3, OUTLINE_COLOUR = '0x6ee7b7';
const DIM = { opacity: 0.55, height: 960 };       // the black layer covers y 0-960 only, so the caption strip below it stays at full brightness
const FADE = 0.4;
const evenWidth = (width, height, to) => Math.round(width * to / height / 2) * 2;

// Where the phone ends up (outline included) for a phone picture of the given size, as ffmpeg's scale=-2 rounds it.
export function phoneBoxes({ width, height }) {
  const box = (size, x, y) => ({ x, y, w: evenWidth(width, height, size.height) + 2 * OUTLINE, h: size.height + 2 * OUTLINE });
  const small = box(SMALL, 0, SMALL.top), large = box(LARGE, 0, LARGE.top);
  small.x = CANVAS.width - SMALL.right - small.w;
  large.x = (CANVAS.width - large.w) / 2;
  return { small, large };
}

export function filterGraph({ crop, phoneCrop = null, seconds, intro = null, focus = null, hideInset = null }) {
  const outline = `pad=iw+${2 * OUTLINE}:ih+${2 * OUTLINE}:${OUTLINE}:${OUTLINE}:color=${OUTLINE_COLOUR}`;
  const last = intro ? 'd' : 'v';
  // Screen recordings have a variable frame rate (a still screen gives few frames), and overlay's enable and fade work on the frames that arrive, so
  // both are brought to FPS first: the dimming and the fades then start and end on time, not at the next frame the recorder happened to write.
  // The computer recording fills the whole canvas (cut at the edges if its shape differs a little from 16:9, never padded with bands).
  const parts = [`[0:v]${cropFilter(crop)}scale=${CANVAS.width}:${CANVAS.height}:force_original_aspect_ratio=increase,crop=${CANVAS.width}:${CANVAS.height},setsar=1,fps=${FPS}[m]`,
    `[1:v]${cropFilter(phoneCrop)}setsar=1,fps=${FPS}${focus ? ',split=2[ps][pl]' : '[ps]'}`,
    `[ps]scale=-2:${SMALL.height},${outline},setsar=1[s]`];
  // the inset can also be cut for a window of its own (--hide-inset), e.g. over the end cards, where it would sit on the computer's text
  const hidden = hideInset ? `*not(between(t,${hideInset.start},${hideInset.end}))` : '';
  if (!focus) parts.push(`[m][s]overlay=W-w-${SMALL.right}:${SMALL.top}:shortest=1${hideInset ? `:enable='1${hidden}'` : ''}[${last}]`);
  else {
    const { start, end } = focus, window = `between(t,${start},${end})`;
    const fades = `fade=t=in:st=${start}:d=${FADE}:alpha=1,fade=t=out:st=${end - FADE}:d=${FADE}:alpha=1`;
    parts.push(
      // the inset is cut for the window (the large phone takes over); the dimming layer and the large phone fade in and out, and are also switched off outside it
      `[m][s]overlay=W-w-${SMALL.right}:${SMALL.top}:shortest=1:enable='not(${window})${hidden}'[a]`,
      `color=c=black@${DIM.opacity}:s=${CANVAS.width}x${DIM.height}:r=${FPS}:d=${seconds},format=yuva420p,${fades}[dim]`,
      `[pl]scale=-2:${LARGE.height},${outline},setsar=1,format=yuva420p,${fades}[l]`,
      `[a][dim]overlay=0:0:enable='${window}'[b]`,
      `[b][l]overlay=(W-w)/2:${LARGE.top}:enable='${window}'[${last}]`);
  }
  if (!intro) return parts.join(';');
  // the picture is fitted into the area above the captions (nothing cropped, the bars match its background) and fades in and out
  const height = CANVAS.height - intro.keep, end = Math.max(0.5, intro.seconds - 0.5);
  return `${parts.join(';')};[2:v]scale=-2:${height},pad=${CANVAS.width}:${height}:(ow-iw)/2:0:color=0x0e1f1b,setsar=1,format=yuva420p,fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=${end}:d=0.5:alpha=1[i];[d][i]overlay=0:0:enable='between(t,0,${intro.seconds})'[v]`;
}

export async function compose(options) {
  for (const file of [options.mac, options.phone, ...(options.intro ? [options.intro] : [])]) await fs.access(file);
  const minDark = options.minDark ?? DEFAULT_MIN_DARK;
  const macSync = findSync(brightness(options.mac, { crop: options.crop }), { minDark });
  // the phone's countdown card is dark only inside the page: the status bar, address bar and navigation bar around it are light, so the search uses the same crop
  const phoneSync = findSync(brightness(options.phone, { crop: options.phoneCrop }), { minDark });
  if (macSync === null || phoneSync === null) throw new Error(`could not find the countdown's end in the ${macSync === null ? 'computer' : 'phone'} recording (it must show the dark countdown card, then the demo)`);
  const seconds = options.seconds;
  checkFocus(options.focus, seconds);
  checkFocus(options.hideInset, seconds, '--hide-inset');
  // the phone's size after any crop decides how wide the inset is; a phone picture that is too wide would cover the computer's page
  const probed = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', options.phone]).trim().split(',').map(Number);
  const [cw, ch] = options.phoneCrop ? options.phoneCrop.split(':').slice(2).map(Number) : probed;
  if (!(cw > 0 && ch > 0)) throw new Error('could not read the size of the phone recording');
  const { small, large } = phoneBoxes({ width: cw, height: ch });
  if (small.x < 1300 || large.x < 0) throw new Error(`the phone picture (${cw}x${ch}) is too wide for the inset; give --phone-crop a taller, narrower box`);
  run('ffmpeg', ['-v', 'error', '-y', '-ss', String(macSync), '-t', String(seconds), '-i', options.mac, '-ss', String(phoneSync), '-t', String(seconds), '-i', options.phone,
    ...(options.intro ? ['-loop', '1', '-t', String(options.introSeconds), '-i', options.intro] : []),
    '-filter_complex', filterGraph({ crop: options.crop, phoneCrop: options.phoneCrop, seconds, focus: options.focus ?? null, hideInset: options.hideInset ?? null, intro: options.intro ? { seconds: options.introSeconds, keep: options.introKeep } : null }), '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-t', String(seconds), options.out]);
  const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', options.out]).trim());
  return { macSync, phoneSync, duration };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await compose(parseArgs(process.argv.slice(2)));
    process.stdout.write(`composed ${result.duration.toFixed(1)} s (the computer recording was lined up at ${result.macSync.toFixed(1)} s, the phone at ${result.phoneSync.toFixed(1)} s)\n`);
  } catch (error) { process.stderr.write(`ERROR ${error.message}\n`); process.exit(1); }
}
