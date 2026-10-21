'use strict';

// Strict five-second pause watchdog. These regression cases intentionally model
// SDK pauses, loading, app switches and rejected native play without claiming
// that a call to play() itself proves playback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../core.js');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function harness({ paused = true, result = () => undefined } = {}) {
  let time = 0;
  let nextClicks = 0;
  const frames = [];
  const attempts = [];
  const video = {
    currentTime: 20, duration: 120, paused,
    ended: false, seeking: false, error: null, readyState: 4, playCalls: 0,
    play() { this.playCalls++; attempts.push(time); return result(this); },
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
    controller, video, frames, attempts,
    enable() { controller.configure({ resumeDelay: 5 }); },
    advance(ms) { time += ms; controller.tick(); },
    get snapshot() { return snapshot; },
    set snapshot(value) { snapshot = value; },
    get time() { return time; },
    get nextClicks() { return nextClicks; },
    get frame() { return frames.at(-1); },
  };
}

const pausedStates = {
  'ordinary pause': () => {},
  'not yet loaded metadata': h => { h.video.readyState = 0; h.video.duration = NaN; },
  'zero duration': h => { h.video.duration = 0; },
  'infinite duration': h => { h.video.duration = Infinity; },
  'unknown playback position': h => { h.video.currentTime = NaN; },
  'active seeking': h => { h.video.seeking = true; },
  'media error': h => { h.video.error = { code: 2 }; },
  'page dialog': h => { h.snapshot = { ...h.snapshot, modal: true }; },
  'hidden page': h => { h.snapshot = { ...h.snapshot, hidden: true }; },
  'temporarily empty source': h => { h.snapshot = { ...h.snapshot, source: '' }; },
};

for (const [state, change] of Object.entries(pausedStates)) {
  test(`five-second watchdog attempts play during ${state}`, () => {
    const h = harness();
    change(h);
    h.enable();
    h.advance(4999);
    assert.equal(h.video.playCalls, 0, 'must wait the complete five seconds');
    h.advance(1);
    assert.equal(h.video.playCalls, 1, 'every paused current video gets a play attempt');
    assert.equal(h.nextClicks, 0, 'an incomplete video is resumed rather than skipped');
    h.advance(4999);
    assert.equal(h.video.playCalls, 1);
    h.advance(1);
    assert.equal(h.video.playCalls, 2, 'the same pause retries even if its loading or page state has not cleared');
  });
}

for (const [state, change] of Object.entries(pausedStates).filter(([name]) => name !== 'ordinary pause')) {
  test(`${state} appearing during countdown cannot cancel or postpone its deadline`, () => {
    const h = harness();
    h.enable();
    h.advance(4000);
    change(h);
    if (state === 'active seeking') h.controller.onSeeking(h.video);
    h.advance(999);
    assert.equal(h.video.playCalls, 0);
    h.advance(1);
    assert.deepEqual(h.attempts, [5000]);
  });
}

test('metadata arriving at four seconds does not start a new five-second countdown', () => {
  const h = harness();
  h.video.readyState = 0;
  h.video.duration = NaN;
  h.video.currentTime = NaN;
  h.enable();
  h.advance(4000);
  h.video.readyState = 4;
  h.video.duration = 120;
  h.video.currentTime = 20;
  h.advance(1000);
  assert.deepEqual(h.attempts, [5000]);
});

test('an initially empty source filled at four seconds still attempts at five, not nine seconds', () => {
  const h = harness();
  h.snapshot = { ...h.snapshot, source: '' };
  h.enable();
  h.advance(4000);
  h.snapshot = { ...h.snapshot, source: 'one.mp4' };
  h.advance(999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.deepEqual(h.attempts, [5000]);
});

test('temporarily clearing and restoring the same source preserves the pause deadline', () => {
  const h = harness();
  h.enable();
  h.advance(2000);
  h.snapshot = { ...h.snapshot, source: '' };
  h.advance(2000);
  h.snapshot = { ...h.snapshot, source: 'one.mp4' };
  h.advance(1000);
  assert.deepEqual(h.attempts, [5000]);
});

test('a real source change after a temporarily empty source receives five fresh seconds', () => {
  const h = harness();
  h.enable();
  h.advance(2000);
  h.snapshot = { ...h.snapshot, source: '' };
  h.advance(2000);
  h.snapshot = { ...h.snapshot, source: 'two.mp4' };
  h.advance(0);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.deepEqual(h.attempts, [9000]);
});

for (const identity of ['route', 'key', 'source', 'video']) {
  test(`a different ${identity} cannot inherit a previous video's four elapsed seconds`, () => {
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
    h.advance(4999);
    assert.equal(h.video.playCalls, 0);
    assert.equal(replacementCalls, 0);
    h.advance(1);
    assert.equal(h.video.playCalls, identity === 'video' ? 0 : 1);
    assert.equal(replacementCalls, identity === 'video' ? 1 : 0);
  });
}

test('duplicate pause and seeking events cannot keep postponing a paused player', () => {
  const h = harness();
  h.enable();
  for (let i = 0; i < 4; i++) {
    h.advance(1000);
    h.controller.onPaused(h.video);
    h.controller.onSeeking(h.video);
  }
  h.advance(1000);
  assert.deepEqual(h.attempts, [5000]);
});

for (const outcome of ['undefined', 'resolved while paused', 'unresolved', 'NotAllowedError', 'AbortError', 'NotSupportedError', 'synchronous error']) {
  test(`a ${outcome} play result retries every five seconds while the video stays paused`, async () => {
    const h = harness({ result: () => {
      if (outcome === 'undefined') return undefined;
      if (outcome === 'resolved while paused') return Promise.resolve();
      if (outcome === 'unresolved') return new Promise(() => {});
      const error = Object.assign(new Error('play failed'), { name: outcome });
      if (outcome === 'synchronous error') throw error;
      return Promise.reject(error);
    } });
    h.enable();
    for (let attempt = 1; attempt <= 6; attempt++) {
      h.advance(4999);
      await flush();
      assert.equal(h.video.playCalls, attempt - 1, 'no earlier bounded-startup retry may bypass five seconds');
      h.advance(1);
      await flush();
      assert.equal(h.video.playCalls, attempt, 'a failed attempt must not stop subsequent watchdog attempts');
      h.advance(0);
      await flush();
      assert.equal(h.video.playCalls, attempt, 'repeated polling at a deadline must not duplicate play');
    }
    assert.deepEqual(h.attempts, [5000, 10000, 15000, 20000, 25000, 30000]);
    assert.equal(h.nextClicks, 0);
  });
}

test('a real playing event cancels retries and the next pause gets a fresh deadline', async () => {
  const h = harness();
  h.enable();
  h.advance(5000);
  await flush();
  h.video.paused = false;
  h.controller.onPlaying(h.video);
  h.advance(30000);
  assert.equal(h.video.playCalls, 1);
  h.video.paused = true;
  h.controller.onPaused(h.video);
  h.advance(4999);
  assert.equal(h.video.playCalls, 1);
  h.advance(1);
  assert.equal(h.video.playCalls, 2);
});

test('polling actual playback without a playing event also clears the old pause deadline', () => {
  const h = harness();
  h.enable();
  h.advance(4000);
  h.video.paused = false;
  h.advance(2000);
  assert.equal(h.video.playCalls, 0);
  h.video.paused = true;
  h.advance(0);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.deepEqual(h.attempts, [11000]);
});

test('a stale playing event received while paused cannot cancel the five-second deadline', () => {
  const h = harness();
  h.enable();
  h.advance(4000);
  h.controller.onPlaying(h.video);
  h.advance(1000);
  assert.deepEqual(h.attempts, [5000]);
});

for (const action of ['cancel', 'infinity']) {
  test(`${action} stops the current pause timer and all subsequent retries`, async () => {
    const h = harness();
    h.enable();
    h.advance(5000);
    await flush();
    h.advance(2000);
    if (action === 'cancel') h.controller.cancelResume();
    else h.controller.configure({ resumeDelay: 0 });
    h.controller.onPaused(h.video);
    h.controller.onSeeking(h.video);
    for (let i = 0; i < 4; i++) { h.advance(60000); await flush(); }
    assert.equal(h.video.playCalls, 1);
    assert.equal(h.nextClicks, 0);
  });

  test(`${action} invalidates a pending rejected play result without rearming retries`, async () => {
    let rejectPlay;
    const h = harness({ result: () => new Promise((resolve, reject) => { rejectPlay = reject; }) });
    h.enable();
    h.advance(5000);
    if (action === 'cancel') h.controller.cancelResume();
    else h.controller.configure({ resumeDelay: 0 });
    rejectPlay(Object.assign(new Error('late rejection'), { name: 'NotAllowedError' }));
    await flush();
    for (let i = 0; i < 3; i++) { h.advance(60000); await flush(); }
    assert.equal(h.video.playCalls, 1);
    assert.equal(h.controller.pending, null, 'late Promise callbacks must not recreate canceled startup');
    assert.equal(h.nextClicks, 0);
  });
}

for (const state of ['near-end', 'ended', 'hidden near-end', 'dialog near-end']) {
  test(`${state} advances once at the pause's five-second deadline without another switch wait`, () => {
    const h = harness();
    h.video.currentTime = h.video.duration - (state === 'ended' ? 0 : 0.17);
    h.video.ended = state === 'ended';
    if (state === 'hidden near-end') h.snapshot = { ...h.snapshot, hidden: true };
    if (state === 'dialog near-end') h.snapshot = { ...h.snapshot, modal: true };
    h.controller.configure({ delay: 10 });
    h.enable();
    h.advance(4999);
    assert.equal(h.nextClicks, 0);
    h.advance(1);
    assert.equal(h.nextClicks, 1, 'five-second mode owns the single deadline even when normal switch wait is ten');
    assert.equal(h.video.playCalls, 0, 'completed media must not be restarted');
    for (let i = 0; i < 6; i++) h.advance(1000);
    assert.equal(h.nextClicks, 1, 'a stable ended snapshot cannot advance multiple times');
  });
}

test('a pause restored to its end at four seconds advances at the original five-second deadline', () => {
  const h = harness();
  h.enable();
  h.advance(4000);
  h.video.currentTime = h.video.duration - 0.17;
  h.advance(999);
  assert.equal(h.nextClicks, 0);
  h.advance(1);
  assert.equal(h.nextClicks, 1);
  assert.equal(h.video.playCalls, 0);
});

test('infinity preserves the ordinary configured natural-end countdown', () => {
  const h = harness();
  h.controller.configure({ delay: 10, resumeDelay: 0 });
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.controller.onEnded(h.video);
  h.advance(5000);
  assert.equal(h.nextClicks, 0);
  assert.equal(h.video.playCalls, 0);
  h.advance(5000);
  assert.equal(h.nextClicks, 1);
});

test('paused active-startup media is adopted by the watchdog without the old three-second retry', async () => {
  const h = harness();
  h.controller.playCurrent();
  await flush();
  assert.equal(h.video.playCalls, 1);
  h.enable();
  h.advance(2999); await flush();
  assert.equal(h.video.playCalls, 1);
  h.advance(1); await flush();
  assert.equal(h.video.playCalls, 1, 'bounded startup cannot bypass the pause watchdog at three seconds');
  h.advance(1999); await flush();
  assert.equal(h.video.playCalls, 1);
  h.advance(1); await flush();
  assert.equal(h.video.playCalls, 2, 'active startup cannot suppress the five-second paused attempt');
  h.advance(0); await flush();
  assert.equal(h.video.playCalls, 2);
});

test('explicit cancellation can end after a genuine new playing-then-pause episode', () => {
  const h = harness();
  h.enable();
  h.advance(2000);
  h.controller.cancelResume();
  h.advance(30000);
  assert.equal(h.video.playCalls, 0);
  h.video.paused = false;
  h.controller.onPlaying(h.video);
  h.video.paused = true;
  h.controller.onPaused(h.video);
  h.advance(5000);
  assert.equal(h.video.playCalls, 1);
});

test('completed media with a temporarily absent next control retries switching instead of replaying', () => {
  const h = harness();
  const next = h.snapshot.next;
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.snapshot = { ...h.snapshot, next: null };
  h.enable();
  h.advance(5000);
  assert.equal(h.video.playCalls, 0, 'a missing next button must never restart completed media');
  assert.equal(h.nextClicks, 0);
  h.advance(1000);
  h.snapshot = { ...h.snapshot, next };
  h.advance(0);
  h.advance(3999);
  assert.equal(h.nextClicks, 0);
  h.advance(1);
  assert.equal(h.nextClicks, 1, 'a missing control must not permanently mark the completion as handled');
  assert.equal(h.video.playCalls, 0);
  h.advance(5000);
  assert.equal(h.nextClicks, 1);
});

test('a replacement next control with the same destination is clicked at the existing five-second deadline', () => {
  const h = harness();
  let replacementClicks = 0;
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.enable();
  h.controller.onEnded(h.video);
  h.advance(4000);
  h.snapshot = { ...h.snapshot, next: { click() { replacementClicks++; } } };
  h.advance(0);
  h.advance(999);
  assert.equal(h.nextClicks, 0);
  assert.equal(replacementClicks, 0);
  h.advance(1);
  assert.equal(h.nextClicks, 0, 'the detached previous control must not be clicked');
  assert.equal(replacementClicks, 1, 're-rendering the same destination must neither cancel nor reset the countdown');
  h.advance(5000);
  assert.equal(replacementClicks, 1);
});

test('an empty source restored during a completed countdown preserves the original deadline', () => {
  const h = harness();
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.enable();
  h.controller.onEnded(h.video);
  h.advance(2000);
  h.snapshot = { ...h.snapshot, source: '' };
  h.advance(2000);
  h.snapshot = { ...h.snapshot, source: 'one.mp4' };
  h.advance(999);
  assert.equal(h.nextClicks, 0);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.equal(h.nextClicks, 1);
  assert.equal(h.video.playCalls, 0);
  h.advance(5000);
  assert.equal(h.nextClicks, 1);
});

test('a next control temporarily removed during completed countdown can recover on the next five-second attempt', () => {
  const h = harness();
  const next = h.snapshot.next;
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.enable();
  h.controller.onEnded(h.video);
  h.advance(4000);
  h.snapshot = { ...h.snapshot, next: null };
  h.advance(1000);
  assert.equal(h.nextClicks, 0);
  assert.equal(h.video.playCalls, 0);
  h.advance(1000);
  h.snapshot = { ...h.snapshot, next };
  h.advance(0);
  h.advance(4000);
  assert.equal(h.nextClicks, 1);
  assert.equal(h.video.playCalls, 0);
});
