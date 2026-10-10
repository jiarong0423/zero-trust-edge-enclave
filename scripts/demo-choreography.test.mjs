import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTIONS, SCENE_SECONDS, CARD, totalSeconds } from './demo-choreography.mjs';

// The storyboard is data: every scene has words and a time, the whole fits a three-minute video, and the words can be read aloud in the time.
test('every scene has a caption and a time, and nothing is left over', () => {
  assert.deepEqual(Object.keys(CAPTIONS).sort(), Object.keys(SCENE_SECONDS).sort());
  for (const [name, text] of Object.entries(CAPTIONS)) { assert.ok(text.length > 10, name); assert.ok(SCENE_SECONDS[name] >= 4, name); }
});

test('the demo fits in three minutes with room for the countdown to be cut, and the captions can be spoken at a calm pace', () => {
  assert.ok(totalSeconds() <= 175, `storyboard is ${totalSeconds()} s`);
  for (const [name, text] of Object.entries(CAPTIONS)) {
    const words = text.replace(/[一-鿿]+/g, 'Liu').split(/\s+/).filter(Boolean).length;
    assert.ok(words / SCENE_SECONDS[name] <= 3, `${name}: ${words} words in ${SCENE_SECONDS[name]} s is too fast`);
  }
});

test('the honesty card says what the video is not claiming', () => {
  const text = CARD.join(' ').toLowerCase();
  for (const phrase of ['not end-to-end', 'simulated', 'hosted demo shows the core flow']) assert.ok(text.includes(phrase), phrase);
});
