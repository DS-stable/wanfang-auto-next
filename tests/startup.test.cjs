'use strict';

// Regression cases from the real Edge run: metadata-only startup and an SDK
// play wrapper that does not return the native Promise. No media is simulated
// as playing merely because play() was called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../core.js');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness({ readyState = 1, result = () => undefined } = {}) {
  let time = 0;
  let clicks = 0;
  const frames = [];
  const previous = {
    currentTime: 104.17, duration: 104.17, paused: true,
    ended: true, seeking: false, error: null, readyState: 4,
  };
  let snapshot = {
    supported: true, route: 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=test',
    key: '1.1 第一课', title: '1.1 第一课', source: 'one.mp4', video: previous,
    nextTitle: '第二课', next: { click() { clicks++; } },
    hidden: false, modal: false, last: false,
  };
  const controller = new Controller({ read: () => snapshot, render: frame => frames.push(frame), now: () => time });
  controller.onEnded(previous);
  time += 5000;
  controller.tick();
  assert.equal(clicks, 1);
  const nextVideo = {
    currentTime: 0, duration: readyState ? 679.85 : NaN, paused: true,
    ended: false, seeking: false, error: null, readyState, playCalls: 0,
    play() { this.playCalls++; return result(this); },
  };
  snapshot = { ...snapshot, key: '1.2 第二课', title: '1.2 第二课', source: 'two.mp4', video: nextVideo };
  controller.tick();
  function advance(ms) { time += ms; controller.tick(); }
  return { controller, nextVideo, advance, frames,
    get snapshot() { return snapshot; },
    set snapshot(value) { snapshot = value; },
    get frame() { return frames.at(-1); },
    get clicks() { return clicks; },
  };
}

test('metadata-only next video receives play without requiring a decoded frame first', async () => {
  const h = harness({ readyState: 1 });
  h.advance(1000);
  await flush();
  assert.equal(h.nextVideo.playCalls, 1, 'play must be allowed to start fetching media after metadata');
  assert.equal(h.clicks, 1, 'loading must never cause another next-lesson click');
});

test('a selected source with preload none can be started before loadedmetadata', async () => {
  const h = harness({ readyState: 0 });
  h.advance(1000);
  await flush();
  assert.equal(h.nextVideo.playCalls, 1, 'a stable selected source needs play even when readyState is zero');
});

test('an undefined play result is not proof that the paused next video started', async () => {
  const h = harness({ readyState: 4 });
  h.advance(1000);
  await flush();
  assert.equal(h.nextVideo.playCalls, 1);
  assert.ok(h.controller.pending, 'keep supervising startup until a real playing signal or progress');
  assert.doesNotMatch(h.frame.message, /^正在播放，/);
});

test('restoring a saved position while paused does not satisfy playback confirmation', async () => {
  const h = harness({ readyState: 4 });
  h.advance(1000);
  await flush();
  h.nextVideo.currentTime = 659.934485;
  h.advance(1000);
  await flush();
  assert.ok(h.controller.pending, 'a paused seek to the saved position is not playback progress');
  assert.doesNotMatch(h.frame.message, /^正在播放，/);
});

test('a real playing event completes pending startup supervision', async () => {
  const h = harness({ readyState: 4 });
  h.advance(1000);
  await flush();
  h.nextVideo.paused = false;
  h.nextVideo.currentTime = 0.5;
  h.controller.onPlaying(h.nextVideo);
  h.advance(1000);
  await flush();
  assert.equal(h.controller.pending, null);
  assert.match(h.frame.message, /^正在播放，/);
});

test('manual navigation during startup never plays the unrelated selected video', async () => {
  const h = harness({ readyState: 1 });
  let unrelatedCalls = 0;
  h.snapshot = { ...h.snapshot, key: '2.1 手动选择', title: '2.1 手动选择', source: 'unrelated.mp4',
    video: { ...h.nextVideo, play() { unrelatedCalls++; } } };
  h.advance(1000);
  await flush();
  assert.equal(unrelatedCalls, 0);
  assert.equal(h.controller.pending, null);
});

test('manual next-video during an end countdown cancels the automatic click and ignores rapid repeats', () => {
  const h = harness();
  let directoryClicks = 0;
  const directoryTarget = { click() { directoryClicks++; } };
  h.snapshot = { ...h.snapshot,
    directoryNext: { node: directoryTarget, key: '1.3', title: '1.3 第三课' },
  };
  h.controller.stop();
  h.nextVideo.currentTime = h.nextVideo.duration;
  h.nextVideo.ended = true;
  h.controller.onEnded(h.nextVideo);
  assert.equal(h.frame.countdown, true);
  assert.equal(h.frame.canContinue, true);
  assert.equal(h.frame.continueLabel, '下一视频');
  h.advance(1000);
  h.controller.continueToNextVideo();
  assert.equal(directoryClicks, 1);
  assert.equal(h.controller.pending?.kind, 'manual');
  assert.equal(h.frame.canContinue, false, 'hide the control while its selected lesson loads');
  h.controller.continueToNextVideo();
  h.controller.onEnded(h.nextVideo);
  h.advance(5000);
  assert.equal(directoryClicks, 1, 'double click and duplicate end must not repeat the directory action');
  assert.equal(h.clicks, 1, 'the old automatic countdown must not click next after the manual action');
});

test('same-media startup retries are capped and never repeat the next-lesson action', async () => {
  const h = harness({ readyState: 1 });
  h.advance(1000); await flush();
  assert.equal(h.nextVideo.playCalls, 1);
  h.advance(2999); await flush();
  assert.equal(h.nextVideo.playCalls, 1);
  h.advance(1); await flush();
  assert.equal(h.nextVideo.playCalls, 2);
  h.advance(3000); await flush();
  assert.equal(h.nextVideo.playCalls, 3);
  h.advance(3000); await flush();
  assert.equal(h.nextVideo.playCalls, 3, 'at most three automatic play attempts');
  assert.equal(h.clicks, 1, 'play retries must not advance the course again');
  assert.ok(h.controller.pending);
});

test('startup receives its own 60-second deadline and retries cannot extend it', async () => {
  const h = harness({ readyState: 1 });
  h.advance(1000); await flush();
  h.advance(59999); await flush();
  assert.ok(h.controller.pending, 'still supervise until the full startup window is exhausted');
  h.advance(1); await flush();
  assert.equal(h.controller.pending, null);
  assert.equal(h.frame.retry, true);
  assert.match(h.frame.message, /播放启动超时/);
  const playCalls = h.nextVideo.playCalls;
  h.advance(60000); await flush();
  assert.equal(h.nextVideo.playCalls, playCalls, 'timed-out startup must stop retrying');
  assert.equal(h.clicks, 1);
});

test('an AbortError during same-media startup can retry without another lesson click', async () => {
  const h = harness({ readyState: 1,
    result: () => Promise.reject(Object.assign(new Error('saved-position seek'), { name: 'AbortError' })),
  });
  h.advance(1000); await flush();
  assert.ok(h.controller.pending);
  assert.equal(h.frame.retry, false);
  h.advance(3000); await flush();
  assert.equal(h.nextVideo.playCalls, 2);
  assert.equal(h.clicks, 1);
  assert.ok(h.controller.pending);
});

test('large saved-position jumps while unpaused are not mistaken for continuous playback', async () => {
  const h = harness({ readyState: 4 });
  h.advance(1000); await flush();
  h.nextVideo.paused = false;
  h.advance(500);
  h.nextVideo.currentTime = 659.934485;
  h.advance(500);
  assert.ok(h.controller.pending, 'a 659-second restore jump over 0.5 seconds is not playback');
  h.advance(500);
  assert.ok(h.controller.pending, 'unchanged time after the restore is still not playback');
  h.nextVideo.currentTime += 0.5;
  h.advance(500);
  assert.equal(h.controller.pending, null, 'subsequent real progress confirms playback');
});

test('manual next-video remains available with automatic advancement disabled', () => {
  const h = harness();
  let directoryClicks = 0;
  h.snapshot = { ...h.snapshot,
    directoryNext: { node: { click() { directoryClicks++; } }, key: '1.3', title: '1.3 第三课' },
  };
  h.controller.configure({ enabled: false });
  assert.equal(h.frame.canContinue, true);
  h.controller.continueToNextVideo();
  assert.equal(directoryClicks, 1);
  assert.equal(h.controller.pending?.kind, 'manual');
  h.advance(500);
  assert.equal(h.controller.pending?.kind, 'manual');
  assert.equal(h.frame.canContinue, false);
});
