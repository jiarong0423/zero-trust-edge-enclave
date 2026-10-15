import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, findSync, filterGraph, phoneBoxes, compose, brightness } from './compose-demo-video.mjs';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('arguments are checked', () => {
  assert.deepEqual(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c']).seconds, 174);     // the demo plays about 172 s after the countdown
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--seconds', '178']).seconds, 178);
  assert.throws(() => parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--seconds', '179']), /under 3 minutes/);
  assert.throws(() => parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--seconds', '4']));
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c']).phoneCrop, null);
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--phone-crop', '0:96:1080:2100']).phoneCrop, '0:96:1080:2100');
  assert.throws(() => parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--phone-crop', 'tall']), /--phone-crop/);
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--mac-crop', '10:20:1280:760']).crop, '10:20:1280:760');
  const base = ['--mac', 'a', '--phone', 'b', '--out', 'c'];
  assert.equal(parseArgs(base).focus, null);                                              // no focus window unless asked: the small inset for the whole video
  assert.deepEqual(parseArgs([...base, '--focus-phone', '101:146']).focus, { start: 101, end: 146 });
  assert.deepEqual(parseArgs([...base, '--focus-phone', '0:2', '--seconds', '5']).focus, { start: 0, end: 2 });
  assert.deepEqual(parseArgs([...base, '--focus-phone', '10.5:20.25']).focus, { start: 10.5, end: 20.25 });
  assert.deepEqual(parseArgs([...base, '--focus-phone', '100:174']).focus, { start: 100, end: 174 });     // the end may equal --seconds
  for (const bad of ['101', '101:', ':146', 'a:b', '-1:5', '1:2:3', '10:11', '10:11.9', '50:40', '50:50', '100:175'])
    assert.throws(() => parseArgs([...base, '--focus-phone', bad]), /--focus-phone/, bad);
  assert.throws(() => parseArgs([...base, '--focus-phone', '10:50', '--seconds', '40']), /not be above --seconds/);   // the order of the options does not matter
  assert.throws(() => parseArgs([...base, '--seconds', '40', '--focus-phone', '10:50']), /not be above --seconds/);
  assert.throws(() => parseArgs([...base, '--focus-phone']), /--focus-phone/);
  for (const bad of [[], ['--mac', 'a'], ['--mac', 'a', '--phone', 'b', '--out', 'c', '--mac-crop', 'wide'], ['--mac', 'a', '--phone', 'b', '--out', 'c', '--phone-crop', '1:2:3'], ['--mac', 'a', '--phone', 'b', '--out', 'c', '--seconds', '999'], ['--nope']]) assert.throws(() => parseArgs(bad));
});

test('the sync point is the first light frame after a dark stretch, and not an earlier flicker', () => {
  const dark = t => ({ t, y: 20 }), light = t => ({ t, y: 230 });
  assert.equal(findSync([light(0), light(0.1), dark(0.2), ...Array.from({ length: 30 }, (_, i) => dark(0.3 + i / 10)), light(3.4), light(3.5)]), 3.4);
  assert.equal(findSync([dark(0), dark(0.1), light(0.2)]), null);        // dark for too short a time: not the countdown
  assert.equal(findSync(Array.from({ length: 20 }, (_, i) => light(i / 10))), null);
});

test('the layout fills the canvas with the computer and lays the phone on it as an inset on the right', () => {
  const graph = filterGraph({ crop: '0:0:1280:760', seconds: 10 });
  assert.match(graph, /\[0:v\]crop=1280:760:0:0,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30\[m\]/);   // the computer fills the canvas, cropped never padded
  assert.doesNotMatch(graph, /color=c=0x0e1f1b/);                                      // no coloured background, so no bands
  assert.doesNotMatch(graph, /pad=1920/);
  assert.match(graph, /\[ps\]scale=-2:700,pad=iw\+6:ih\+6:3:3:color=0x6ee7b7/);            // the phone: 700 px high, 3 px mint outline
  assert.match(graph, /overlay=W-w-20:100:shortest=1\[v\]/);                           // 20 px from the right, top at y=100
  assert.doesNotMatch(graph, /split|\[pl\]|black/);                                    // no focus: no second use of the phone, no dimming
  assert.doesNotMatch(graph, /\[1:v\]crop/);
  assert.match(filterGraph({ crop: null, phoneCrop: '0:190:720:1322', seconds: 10 }), /\[1:v\]crop=720:1322:0:190,setsar=1,fps=30\[ps\];\[ps\]scale=-2:700/);   // the phone is cut before it is scaled
});

test('the focus window dims the computer above the captions, enlarges the phone, cuts the inset and fades both ways', () => {
  const graph = filterGraph({ crop: null, phoneCrop: '0:190:720:1322', seconds: 174, focus: { start: 101, end: 146 } });
  assert.match(graph, /setsar=1,fps=30,split=2\[ps\]\[pl\]/);                                   // the phone input is used twice
  assert.match(graph, /\[m\]\[s\]overlay=W-w-20:100:shortest=1:enable='not\(between\(t,101,146\)\)'\[a\]/);   // the inset is gone during the window and back after it
  assert.match(graph, /color=c=black@0\.55:s=1920x960:r=30:d=174,format=yuva420p,fade=t=in:st=101:d=0\.4:alpha=1,fade=t=out:st=145\.6:d=0\.4:alpha=1\[dim\]/);   // 55 % black over y 0-960 only
  assert.match(graph, /\[pl\]scale=-2:880,pad=iw\+6:ih\+6:3:3:color=0x6ee7b7,setsar=1,format=yuva420p,fade=t=in:st=101:d=0\.4:alpha=1,fade=t=out:st=145\.6:d=0\.4:alpha=1\[l\]/);
  assert.match(graph, /\[a\]\[dim\]overlay=0:0:enable='between\(t,101,146\)'\[b\]/);
  assert.match(graph, /\[b\]\[l\]overlay=\(W-w\)\/2:40:enable='between\(t,101,146\)'\[v\]/);       // large phone centred, top at y=40
  // with an intro the last overlay is the intro, as before
  const withIntro = filterGraph({ crop: null, seconds: 174, focus: { start: 101, end: 146 }, intro: { seconds: 6, keep: 130 } });
  assert.match(withIntro, /\[l\]overlay=\(W-w\)\/2:40:enable='between\(t,101,146\)'\[d\]/);
  assert.match(withIntro, /\[d\]\[i\]overlay=0:0:enable='between\(t,0,6\)'\[v\]/);
});

test('the phone stays inside the canvas, in its inset right of x=1300 and above the caption strip, and large above the dimmed area, for 9:20, 9:16 and cropped phones', () => {
  // 720x1600 is the real phone's recording, 720x1322 its crop, 1080x2400 a 9:20 phone, 1080x1920 a 9:16 phone, 1080x2100 a cropped one
  for (const [width, height, expectedSmall] of [[720, 1322, 388], [720, 1600, 322], [1080, 2400, 322], [1080, 1920, 400], [1080, 2100, 366]]) {
    const { small, large } = phoneBoxes({ width, height });
    const name = `${width}x${height}`;
    assert.ok(Math.abs(small.w - expectedSmall) <= 2, `${name}: small width ${small.w}`);
    assert.equal(small.h, 706);
    assert.equal(small.y, 100);
    assert.ok(small.x >= 1300, `${name}: small starts at ${small.x}`);
    assert.equal(small.x + small.w, 1900);                                         // 20 px from the right edge
    assert.ok(small.y + small.h <= 880, `${name}: small ends at ${small.y + small.h}`);   // clear of the caption strip (bottom ~120 px)
    assert.ok(large.x >= 0 && large.x + large.w <= 1920, `${name}: large x ${large.x}-${large.x + large.w}`);
    assert.equal(large.x * 2 + large.w, 1920);                                     // centred
    assert.equal(large.y, 40);
    assert.ok(large.y + large.h <= 960, `${name}: large ends at ${large.y + large.h}`);   // inside the dimmed area, above the caption strip
    assert.equal(large.h, 886);
  }
});

test('two recordings started at different moments are lined up by their countdown and composed', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-'));
  try {
    const clip = (file, size, darkSeconds, lightSeconds) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${size}:r=30:d=${darkSeconds}`, '-f', 'lavfi', '-i', `color=c=0xf0f0f0:s=${size}:r=30:d=${lightSeconds}`,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const mac = path.join(dir, 'mac.mp4'), phone = path.join(dir, 'phone.mp4'), out = path.join(dir, 'out.mp4');
    clip(mac, '1280x760', 4, 9);       // the computer recording began 4 s before the demo
    clip(phone, '540x1200', 2, 9);     // the phone recording began 2 s before it
    const result = await compose({ mac, phone, out, minDark: 1, crop: null, seconds: 6 });
    assert.ok(Math.abs(result.macSync - 4) < 0.25, `computer sync ${result.macSync}`);
    assert.ok(Math.abs(result.phoneSync - 2) < 0.25, `phone sync ${result.phoneSync}`);
    assert.ok(Math.abs(result.duration - 6) < 0.3, `duration ${result.duration}`);
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    assert.equal(size, '1920,1080');
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    assert.equal(audio, '');           // no sound is added
    await assert.rejects(compose({ mac: out, phone: out, out: path.join(dir, 'x.mp4'), minDark: 1, crop: null, seconds: 6 }), /countdown/);   // no dark card in the finished video
    await assert.rejects(compose({ mac: phone, phone: mac, out, minDark: 1, crop: null, seconds: 6 }), /too wide for the inset/);   // a landscape picture in the phone's place would cover the page
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an opening picture is optional, checked, and laid over the canvas above the captions', () => {
  const base = ['--mac', 'a', '--phone', 'b', '--out', 'c'];
  assert.equal(parseArgs(base).intro, null);
  assert.equal(parseArgs(base).introKeep, 130);                                                     // the open scene's two-line caption starts at about y 966; the picture stops above it
  const set = parseArgs([...base, '--intro', 'i.png', '--intro-seconds', '5', '--intro-keep', '120']);
  assert.deepEqual([set.intro, set.introSeconds, set.introKeep], ['i.png', 5, 120]);
  for (const bad of [['--intro-seconds', '0'], ['--intro-seconds', '99'], ['--intro-keep', '-1'], ['--intro-keep', 'tall']]) assert.throws(() => parseArgs([...base, ...bad]));
  assert.doesNotMatch(filterGraph({ crop: null, seconds: 10 }), /\[2:v\]/);                       // without it the layout is exactly as before
  const graph = filterGraph({ crop: null, seconds: 10, intro: { seconds: 6, keep: 130 } });
  assert.match(graph, /scale=-2:950,pad=1920:950/);                                                  // fitted above the caption strip, nothing cropped
  assert.match(graph, /fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=5.5:d=0.5:alpha=1/);
  assert.match(graph, /enable='between\(t,0,6\)'/);
});

test('the opening picture covers the first seconds and then lets the demo show', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-intro-'));
  try {
    const clip = (file, size) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${size}:r=30:d=2`, '-f', 'lavfi', '-i', `color=c=0xe0e0e0:s=${size}:r=30:d=12`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const mac = path.join(dir, 'mac.mp4'), phone = path.join(dir, 'phone.mp4'), out = path.join(dir, 'out.mp4'), intro = path.join(dir, 'intro.png');
    clip(mac, '1280x760'); clip(phone, '540x1200');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00c000:s=1672x941', '-frames:v', '1', intro]);
    const result = await compose({ mac, phone, out, minDark: 1, crop: null, seconds: 8, intro, introSeconds: 3, introKeep: 130 });
    assert.ok(Math.abs(result.duration - 8) < 0.3, `duration ${result.duration}`);   // the picture does not add length
    const pixel = (at, x, y) => [...execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', out, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])];
    const [r1, g1, b1] = pixel(1.5, 960, 400), [r2, g2, b2] = pixel(5, 960, 400), [, gBottom] = pixel(1.5, 600, 1000);
    assert.ok(g1 > 150 && r1 < 60 && b1 < 60, `covered at 1.5 s: ${[r1, g1, b1]}`);
    assert.ok(Math.abs(g2 - r2) < 25, `demo visible at 5 s: ${[r2, g2, b2]}`);
    assert.ok(gBottom < 150 || Math.abs(gBottom - 0xe0) < 40, `the caption strip is not covered at 1.5 s: ${gBottom}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a cropped 9:16 phone recording is composed into 1920x1080', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-crop-'));
  try {
    const clip = (file, size) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${size}:r=30:d=2`, '-f', 'lavfi', '-i', `color=c=0xe0e0e0:s=${size}:r=30:d=6`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const mac = path.join(dir, 'mac.mp4'), phone = path.join(dir, 'phone.mp4'), out = path.join(dir, 'out.mp4');
    clip(mac, '1280x720'); clip(phone, '540x960');
    const result = await compose({ mac, phone, out, minDark: 1, crop: null, phoneCrop: '0:48:540:864', seconds: 5 });       // 540x864 is 5:8, wider than 9:20
    assert.ok(Math.abs(result.duration - 5) < 0.3, `duration ${result.duration}`);
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    assert.equal(size, '1920,1080');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the focus window dims the computer and shows the large phone, and outside it the inset sits on a full-bright computer', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-focus-'));
  try {
    // computer: yellow, phone: cyan (both light enough to be found after a dark countdown); window 4-8 s of a 10 s video, intro over the first 2 s
    const MAC = [0xc0, 0xa0, 0x40], PHONE = [0x40, 0xc0, 0xd0], MINT = [0x6e, 0xe7, 0xb7];
    const hex = rgb => `0x${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`;
    const clip = (file, size, colour) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${size}:r=30:d=2`, '-f', 'lavfi', '-i', `color=c=${hex(colour)}:s=${size}:r=30:d=14`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const mac = path.join(dir, 'mac.mp4'), phone = path.join(dir, 'phone.mp4'), plain = path.join(dir, 'plain.mp4'), focused = path.join(dir, 'focused.mp4'), intro = path.join(dir, 'intro.png');
    clip(mac, '1280x720', MAC); clip(phone, '540x1200', PHONE);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00c000:s=1672x941', '-frames:v', '1', intro]);
    const a = await compose({ mac, phone, out: plain, minDark: 1, crop: null, seconds: 10 });
    const b = await compose({ mac, phone, out: focused, minDark: 1, crop: null, seconds: 10, focus: { start: 4, end: 8 }, intro, introSeconds: 2, introKeep: 130 });
    const probe = file => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
    for (const [file, result] of [[plain, a], [focused, b]]) {
      assert.equal(probe(file), '1920,1080');                                       // (a) the size and the length
      assert.ok(Math.abs(result.duration - 10) < 0.3, `duration ${result.duration}`);
    }
    const pixel = (file, at, x, y) => [...execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])];
    const near = (got, want, tolerance, what) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= tolerance, `${what}: got ${got}, wanted about ${want}`));
    const dimmed = MAC.map(v => v * 0.45);
    // (b) outside the window the computer's centre shows the computer, with and without the focus option; the inset is in the corner
    near(pixel(plain, 6, 960, 540), MAC, 20, 'plain, centre at 6 s');
    near(pixel(focused, 3, 960, 540), MAC, 20, 'focused, centre at 3 s');
    near(pixel(focused, 9, 960, 540), MAC, 20, 'focused, centre at 9 s');
    near(pixel(plain, 6, 1740, 450), PHONE, 20, 'plain, inset at 6 s');
    near(pixel(plain, 6, phoneBoxes({ width: 540, height: 1200 }).small.x + 1, 450), MINT, 45, 'plain, inset outline');   // the 3 px outline is the outer 3 px of the box
    near(pixel(plain, 6, 100, 540), MAC, 20, 'plain, far left');
    near(pixel(focused, 3, 1740, 450), PHONE, 20, 'focused, inset before the window');
    near(pixel(focused, 9, 1740, 450), PHONE, 20, 'focused, inset is back after the window');
    // (c) inside the window, after the fade: the large phone covers the centre, the rest of the computer is darkened, the inset is gone
    near(pixel(focused, 6, 960, 540), PHONE, 20, 'focused, large phone at 6 s');
    near(pixel(focused, 6, 960, 60), PHONE, 20, 'focused, large phone near its top edge');
    near(pixel(focused, 6, 100, 540), dimmed, 20, 'focused, far left is darkened');
    near(pixel(focused, 6, 1740, 450), dimmed, 20, 'focused, the inset is cut and its place shows the dimmed computer');
    near(pixel(focused, 6, 100, 30), dimmed, 20, 'focused, top left is darkened');
    // (d) the caption strip below y=960 keeps full brightness
    near(pixel(focused, 6, 200, 1040), MAC, 20, 'focused, caption strip at 6 s');
    near(pixel(focused, 6, 1000, 1040), MAC, 20, 'focused, caption strip below the phone');
    // the fade: halfway through the fade-in the picture is between the full and the dimmed colour
    const [half] = pixel(focused, 4.2, 100, 540);
    assert.ok(half < MAC[0] - 8 && half > dimmed[0] + 8, `halfway through the fade: ${half}`);
    // (e) the intro still covers the first seconds above the captions, and lets go
    near(pixel(focused, 1, 960, 400), [0x00, 0xc0, 0x00], 40, 'intro at 1 s');
    near(pixel(focused, 1, 100, 1040), MAC, 20, 'intro leaves the caption strip');
    near(pixel(focused, 3, 960, 400), MAC, 20, 'intro gone at 3 s');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a recording with few frames (a still screen) still gets the dimming and the fades on time', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-vfr-'));
  try {
    // the computer is written at 1 frame per second, as a recorder does for a still screen; the window 4.5-8.5 falls between its frames
    const MAC = [0xc0, 0xa0, 0x40], PHONE = [0x40, 0xc0, 0xd0];
    const clip = (file, size, colour, rate) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${size}:r=${rate}:d=2`, '-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:r=${rate}:d=14`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const mac = path.join(dir, 'mac.mp4'), phone = path.join(dir, 'phone.mp4'), out = path.join(dir, 'out.mp4');
    clip(mac, '1280x720', '0xc0a040', 1); clip(phone, '540x1200', '0x40c0d0', 30);
    await compose({ mac, phone, out, minDark: 1, crop: null, seconds: 10, focus: { start: 4.5, end: 8.5 } });
    const pixel = (at, x, y) => [...execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', out, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])];
    assert.ok(pixel(4.8, 100, 540)[0] < MAC[0] * 0.8, `dimming has begun at 4.8 s: ${pixel(4.8, 100, 540)}`);       // 75 % through the fade-in, although no computer frame is near
    assert.ok(Math.abs(pixel(8.7, 100, 540)[0] - MAC[0]) < 20, `dimming is gone at 8.7 s: ${pixel(8.7, 100, 540)}`);
    assert.ok(Math.abs(pixel(8.7, 1740, 450)[0] - PHONE[0]) < 20, `the inset is back at 8.7 s: ${pixel(8.7, 1740, 450)}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the phone countdown is found inside the page area even when light bars around it keep the whole frame bright', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-bars-'));
  try {
    // a 360x800 phone picture: light bars on top (130 px) and bottom (90 px), about a quarter of the frame like the real phone, and a middle that is dark for 3 s then light
    const strip = (colour, h, d) => ['-f', 'lavfi', '-i', `color=c=${colour}:s=360x${h}:r=10:d=${d}`];
    const phone = path.join(dir, 'phone.mp4'), mac = path.join(dir, 'mac.mp4'), out = path.join(dir, 'out.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...strip('0xf0f0f0', 130, 8), ...strip('0xf0f0f0', 90, 8), ...strip('0x101010', 580, 3), ...strip('0xe8e8e8', 580, 5),
      '-filter_complex', '[2:v][3:v]concat=n=2:v=1:a=0[mid];[0:v][mid][1:v]vstack=3[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', phone]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x101010:s=640x360:r=10:d=3', '-f', 'lavfi', '-i', 'color=c=0xe0e0e0:s=640x360:r=10:d=5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mac]);
    const whole = findSync(brightness(phone, { fps: 10, seconds: 10 })), cropped = findSync(brightness(phone, { fps: 10, seconds: 10, crop: '0:130:360:580' }));
    assert.equal(whole, null);                                   // the light bars hide the dark card from a whole-frame scan
    assert.ok(Math.abs(cropped - 3) < 0.3, `cropped sync ${cropped}`);
    const result = await compose({ mac, phone, out, minDark: 1, crop: null, phoneCrop: '0:130:360:580', seconds: 4 });
    assert.ok(Math.abs(result.phoneSync - 3) < 0.3, `phone sync ${result.phoneSync}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a short black spell before the countdown (macOS entering full screen) is not taken for the countdown', () => {
  const at = (t, y) => ({ t, y });
  const run = (from, to, y) => Array.from({ length: Math.round((to - from) * 10) }, (_, i) => at(from + i / 10, y));
  // 0-10 s desktop (light), 10-12.5 s black transition, 12.5-14 s page (light), 14-39 s countdown card (dark), then the demo (light)
  const samples = [...run(0, 10, 200), ...run(10, 12.5, 5), ...run(12.5, 14, 220), ...run(14, 39, 25), ...run(39, 60, 220)];
  assert.equal(findSync(samples, { minDark: 1 }), 12.5);                       // the old rule is fooled by the transition
  assert.ok(Math.abs(findSync(samples, { minDark: 10 }) - 39) < 0.11);         // the countdown has to last 10 s (compose's default; findSync itself keeps 1 s)
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c']).minDark, 10);
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--min-dark', '3']).minDark, 3);
  for (const bad of ['0', '61', 'long']) assert.throws(() => parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--min-dark', bad]));
});

test('the phone inset can be cut for a window of its own, for instance over the end cards', () => {
  const base = ['--mac', 'a', '--phone', 'b', '--out', 'c'];
  assert.equal(parseArgs(base).hideInset, null);
  assert.deepEqual(parseArgs([...base, '--hide-inset', '146:174']).hideInset, { start: 146, end: 174 });
  for (const bad of ['146', '146:147', '170:200', 'a:b']) assert.throws(() => parseArgs([...base, '--hide-inset', bad]), /--hide-inset/, bad);
  // without a focus window the inset is cut only over its own window; with one, it is cut for both windows
  const only = filterGraph({ crop: null, seconds: 174, hideInset: { start: 146, end: 174 } });
  assert.match(only, /overlay=W-w-20:100:shortest=1:enable='1\*not\(between\(t,146,174\)\)'/);
  const both = filterGraph({ crop: null, seconds: 174, focus: { start: 101, end: 146 }, hideInset: { start: 146, end: 174 } });
  assert.match(both, /enable='not\(between\(t,101,146\)\)\*not\(between\(t,146,174\)\)'/);
  assert.doesNotMatch(filterGraph({ crop: null, seconds: 174 }), /not\(between/);                     // no window, no expression
});
