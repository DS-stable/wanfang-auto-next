'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../core.js');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness({ paused = true, result = () => undefined } = {}) {
  let time = 0;
  let nextClicks = 0;
  const frames = [];
  const video = {
    currentTime: 20, duration: 120, paused,
    ended: false, seeking: false, error: null, readyState: 4, playCalls: 0,
    play() { this.playCalls++; return result(this); },
  };
  let snapshot = {
    supported: true, route: 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=test',
    key: '1.1 第一课', title: '1.1 第一课', source: 'one.mp4', video,
    nextTitle: '第二课', next: { click() { nextClicks++; } },
    hidden: false, modal: false, last: false, nonVideo: false,
  };
  const controller = new Controller({ read: () => snapshot, render: frame => frames.push(frame), now: () => time });
  controller.tick();
  return {
    controller, video, frames,
    enable() { controller.configure({ resumeDelay: 5 }); },
    advance(ms) { time += ms; controller.tick(); },
    get snapshot() { return snapshot; },
    set snapshot(value) { snapshot = value; },
    get time() { return time; },
    get nextClicks() { return nextClicks; },
    get frame() { return frames.at(-1); },
  };
}

test('saved five-second preference recovers a video loaded after controller startup without any pause event', () => {
  const h = harness();
  h.snapshot = { ...h.snapshot, video: null, source: '' };
  h.enable();
  h.advance(1500);
  h.video.readyState = 1;
  h.snapshot = { ...h.snapshot, video: h.video, source: 'late.mp4' };
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 6500);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.equal(h.video.playCalls, 1);
});

test('metadata and a playable source must become valid before a fresh five-second countdown begins', () => {
  const h = harness();
  h.snapshot = { ...h.snapshot, source: '' };
  h.video.readyState = 0;
  h.enable();
  h.advance(10000);
  assert.equal(h.controller.resumePending, null);
  h.snapshot = { ...h.snapshot, source: 'loaded.mp4' };
  h.advance(10000);
  assert.equal(h.controller.resumePending, null);
  h.video.readyState = 1;
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 25000);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.equal(h.video.playCalls, 1);
});

for (const duration of [NaN, Infinity, 0, -1]) {
  test(`invalid metadata duration ${duration} never starts a resume attempt`, () => {
    const h = harness();
    h.video.duration = duration;
    h.enable();
    for (let i = 0; i < 4; i++) h.advance(60000);
    assert.equal(h.controller.resumePending, null);
    assert.equal(h.video.playCalls, 0);
    assert.equal(h.nextClicks, 0);
  });
}

test('polling the same already-paused media starts once when its lesson identity becomes known', () => {
  const h = harness();
  h.snapshot = { ...h.snapshot, key: '' };
  h.enable();
  h.advance(1000);
  assert.equal(h.controller.resumePending, null);
  h.snapshot = { ...h.snapshot, key: '1.1 第一课' };
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 6000);
  for (let i = 0; i < 4; i++) {
    h.advance(1000);
    assert.equal(h.controller.resumePending?.deadline, 6000, 'stable polling must not postpone the deadline');
  }
  h.advance(1000);
  assert.equal(h.video.playCalls, 1);
});

test('five-second recovery resumes the same paused video while the page remains hidden', async () => {
  const h = harness({ result: video => { video.paused = false; return Promise.resolve(); } });
  h.snapshot = { ...h.snapshot, hidden: true };
  h.enable();
  assert.equal(h.controller.resumePending?.deadline, 5000);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  await flush();
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.snapshot.hidden, true, 'same-video recovery must not spoof document visibility');
  assert.equal(h.nextClicks, 0);
});

test('switching applications during a pause countdown keeps the original same-video deadline', async () => {
  const h = harness({ result: video => { video.paused = false; return Promise.resolve(); } });
  h.enable();
  h.advance(2000);
  h.snapshot = { ...h.snapshot, hidden: true };
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 5000);
  h.advance(3000);
  await flush();
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.nextClicks, 0);
});

test('SDK progress restoration defers recovery until seeking settles, including while hidden', async () => {
  const h = harness({ result: video => { video.paused = false; return Promise.resolve(); } });
  h.enable();
  h.advance(2000);
  h.snapshot = { ...h.snapshot, hidden: true };
  h.video.seeking = true;
  h.controller.onSeeking(h.video);
  h.advance(10000);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.video.playCalls, 0);
  h.video.currentTime = 40;
  h.video.seeking = false;
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 17000);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  await flush();
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.nextClicks, 0);
});

test('a short seeking event restarts a complete countdown even if it settles before the next poll', () => {
  const h = harness();
  h.enable();
  h.advance(4000);
  h.controller.onSeeking(h.video);
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 9000);
  h.advance(1000);
  assert.equal(h.video.playCalls, 0);
  h.advance(4000);
  assert.equal(h.video.playCalls, 1);
});

for (const identity of ['route', 'key', 'source', 'video']) {
  test(`a changed ${identity} receives its own full countdown instead of inheriting the previous timer`, () => {
    const h = harness();
    h.enable();
    h.advance(4000);
    let replacementCalls = 0;
    if (identity === 'video') {
      h.snapshot = { ...h.snapshot, video: { ...h.video, play() { replacementCalls++; } } };
    } else {
      h.snapshot = { ...h.snapshot, [identity]: `replacement-${identity}` };
    }
    h.advance(0);
    assert.equal(h.controller.resumePending?.deadline, 9000);
    assert.equal(h.controller.resumePending?.origin[identity], h.snapshot[identity]);
    h.advance(1000);
    assert.equal(h.video.playCalls, 0);
    assert.equal(replacementCalls, 0);
    h.advance(3999);
    assert.equal(h.video.playCalls, 0);
    assert.equal(replacementCalls, 0);
    h.advance(1);
    assert.equal(h.video.playCalls, identity === 'video' ? 0 : 1);
    assert.equal(replacementCalls, identity === 'video' ? 1 : 0);
  });
}

test('refresh-restored 104/104.17 paused media advances once without requiring a native ended event', () => {
  const h = harness();
  h.video.currentTime = 104;
  h.video.duration = 104.17;
  h.video.ended = false;
  h.enable();
  assert.equal(h.controller.resumePending, null);
  h.advance(999);
  assert.equal(h.controller.pending, null, 'a restored end position must settle before it can advance');
  h.advance(1);
  assert.equal(h.controller.pending?.phase, 'countdown');
  assert.equal(h.controller.pending?.completion, 'recovery');
  h.advance(4999);
  assert.equal(h.nextClicks, 0);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.equal(h.nextClicks, 1);
  for (let i = 0; i < 5; i++) h.advance(1000);
  assert.equal(h.nextClicks, 1);
  assert.equal(h.video.playCalls, 0, 'completed media must never be replayed by timed recovery');
});

test('a pause countdown reaching the end hands off to next-video recovery instead of replaying', () => {
  const h = harness();
  h.enable();
  h.advance(2000);
  h.video.currentTime = h.video.duration - 0.17;
  h.advance(0);
  assert.equal(h.controller.resumePending, null);
  h.advance(1000);
  assert.equal(h.controller.pending?.phase, 'countdown');
  assert.equal(h.controller.pending?.completion, 'recovery');
  h.advance(4999);
  assert.equal(h.nextClicks, 0);
  h.advance(1);
  assert.equal(h.nextClicks, 1);
  assert.equal(h.video.playCalls, 0);
});

test('turning auto-next off prevents end recovery but still allows ordinary same-video resume', () => {
  const h = harness();
  h.video.currentTime = h.video.duration - 0.17;
  h.controller.configure({ enabled: false, resumeDelay: 5 });
  h.advance(60000);
  assert.equal(h.nextClicks, 0);
  assert.equal(h.video.playCalls, 0);
  h.video.currentTime = 30;
  h.advance(0);
  assert.equal(h.controller.resumePending?.deadline, 65000);
  h.advance(5000);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.nextClicks, 0);
});

test('background completion recovery never clicks the next-video control', () => {
  const h = harness();
  h.snapshot = { ...h.snapshot, hidden: true };
  h.video.currentTime = h.video.duration - 0.17;
  h.enable();
  for (let i = 0; i < 4; i++) h.advance(60000);
  assert.equal(h.nextClicks, 0);
  assert.equal(h.video.playCalls, 0);
});

test('infinity preserves both an already-paused and a near-completed refresh-restored video', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.advance(60000);
  h.video.currentTime = h.video.duration - 0.17;
  for (let i = 0; i < 3; i++) h.advance(60000);
  assert.equal(h.controller.resumeDelay, 0);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.controller.pending, null);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.nextClicks, 0);
});

test('explicit cancellation remains blocked when a later SDK seeking event settles', () => {
  const h = harness();
  h.enable();
  h.advance(2000);
  h.controller.cancelResume();
  h.video.seeking = true;
  h.controller.onSeeking(h.video);
  h.advance(1000);
  h.video.seeking = false;
  for (let i = 0; i < 4; i++) h.advance(60000);
  assert.equal(h.controller.resumeDelay, 5);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.video.playCalls, 0);
});

for (const name of ['NotAllowedError', 'NotSupportedError']) {
  test(`${name} cannot be retried endlessly by stable paused-state polling`, async () => {
    const h = harness({ result: () => Promise.reject(Object.assign(new Error('play rejected'), { name })) });
    h.enable();
    h.advance(5000);
    await flush();
    assert.equal(h.video.playCalls, 1);
    assert.equal(h.controller.pending, null);
    assert.equal(h.frame.retry, true);
    h.controller.onPaused(h.video);
    for (let i = 0; i < 5; i++) {
      h.advance(60000);
      await flush();
    }
    assert.equal(h.video.playCalls, 1);
    assert.equal(h.controller.resumePending, null);
    h.video.paused = false;
    h.controller.onPlaying(h.video);
    h.video.paused = true;
    h.advance(0);
    assert.equal(h.controller.resumePending?.deadline, h.time + 5000);
  });
}
