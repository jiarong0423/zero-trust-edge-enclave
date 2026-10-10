import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, findSync, filterGraph, compose } from './compose-demo-video.mjs';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('arguments are checked', () => {
  assert.deepEqual(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c']).seconds, 171);
  assert.equal(parseArgs(['--mac', 'a', '--phone', 'b', '--out', 'c', '--mac-crop', '10:20:1280:760']).crop, '10:20:1280:760');
  for (const bad of [[], ['--mac', 'a'], ['--mac', 'a', '--phone', 'b', '--out', 'c', '--mac-crop', 'wide'], ['--mac', 'a', '--phone', 'b', '--out', 'c', '--seconds', '999'], ['--nope']]) assert.throws(() => parseArgs(bad));
});

test('the sync point is the first light frame after a dark stretch, and not an earlier flicker', () => {
  const dark = t => ({ t, y: 20 }), light = t => ({ t, y: 230 });
  assert.equal(findSync([light(0), light(0.1), dark(0.2), ...Array.from({ length: 30 }, (_, i) => dark(0.3 + i / 10)), light(3.4), light(3.5)]), 3.4);
  assert.equal(findSync([dark(0), dark(0.1), light(0.2)]), null);        // dark for too short a time: not the countdown
  assert.equal(findSync(Array.from({ length: 20 }, (_, i) => light(i / 10))), null);
});

test('the layout puts the computer window on the left and the phone on the right inside 1920x1080', () => {
  const graph = filterGraph({ crop: '0:0:1280:760', seconds: 10 });
  assert.match(graph, /crop=1280:760:0:0/);
  assert.match(graph, /s=1920x1080/);
  assert.match(graph, /overlay=40:/);
  assert.match(graph, /overlay=W-w-60:/);
});

test('two recordings started at different moments are lined up by their countdown and composed', { skip: !hasFfmpeg }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-'));
  try {
    const clip = (file, size, darkSeconds, lightSeconds) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${size}:r=30:d=${darkSeconds}`, '-f', 'lavfi', '-i', `color=c=0xf0f0f0:s=${size}:r=30:d=${lightSeconds}`,
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const mac = path.join(dir, 'mac.mp4'), phone = path.join(dir, 'phone.mp4'), out = path.join(dir, 'out.mp4');
    clip(mac, '1280x760', 4, 9);       // the computer recording began 4 s before the demo
    clip(phone, '540x1200', 2, 9);     // the phone recording began 2 s before it
    const result = await compose({ mac, phone, out, crop: null, seconds: 6 });
    assert.ok(Math.abs(result.macSync - 4) < 0.25, `computer sync ${result.macSync}`);
    assert.ok(Math.abs(result.phoneSync - 2) < 0.25, `phone sync ${result.phoneSync}`);
    assert.ok(Math.abs(result.duration - 6) < 0.3, `duration ${result.duration}`);
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    assert.equal(size, '1920,1080');
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim();
    assert.equal(audio, '');           // no sound is added
    await assert.rejects(compose({ mac: phone, phone: mac, out, crop: null, seconds: 6 }).then(() => compose({ mac: out, phone: out, out: path.join(dir, 'x.mp4'), crop: null, seconds: 6 })), /countdown/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
