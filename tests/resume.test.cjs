'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../core.js');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness({ paused = false, result = () => undefined } = {}) {
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
    pause({ event = true } = {}) {
      video.paused = true;
      if (event) controller.onPaused(video);
      else controller.tick();
    },
    playing() {
      video.paused = false;
      controller.onPlaying(video);
    },
    advance(ms) { time += ms; controller.tick(); },
    get time() { return time; },
    get snapshot() { return snapshot; },
    set snapshot(value) { snapshot = value; },
    get frame() { return frames.at(-1); },
    get nextClicks() { return nextClicks; },
  };
}

test('infinity is the default and leaves a paused video untouched', () => {
  const h = harness();
  assert.equal(h.controller.resumeDelay, 0);
  assert.equal(h.frame.resumeDelay, 0);
  h.pause();
  h.advance(600000);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.nextClicks, 0);
});

test('a pause resumes this same video after a complete five seconds', async () => {
  const h = harness();
  h.enable();
  h.pause();
  assert.equal(h.controller.resumePending?.deadline, h.time + 5000);
  assert.equal(h.frame.resumeCountdown, true);
  assert.equal(h.frame.resumeDelay, 5);
  assert.equal(h.frame.canResume, true);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  await flush();
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.controller.pending?.resume, true);
  assert.equal(h.nextClicks, 0, 'a resume must never click another lesson');
});

test('repeated pause events do not postpone the original deadline', () => {
  const h = harness();
  h.enable();
  h.pause();
  const deadline = h.controller.resumePending.deadline;
  h.advance(2000);
  h.controller.onPaused(h.video);
  assert.equal(h.controller.resumePending.deadline, deadline);
  h.advance(3000);
  assert.equal(h.video.playCalls, 1);
});

test('polling detects a playing-to-paused transition without a native pause event', () => {
  const h = harness();
  h.enable();
  h.pause({ event: false });
  assert.ok(h.controller.resumePending);
  h.advance(5000);
  assert.equal(h.video.playCalls, 1);
});

test('explicitly enabling five-second mode starts a countdown for the currently paused video', () => {
  const h = harness({ paused: true });
  h.advance(20000);
  h.enable();
  assert.equal(h.controller.resumePending?.deadline, 25000);
  h.advance(4999);
  assert.equal(h.video.playCalls, 0);
  h.advance(1);
  assert.equal(h.video.playCalls, 1);
});

test('a newly selected paused video does not start merely because five-second mode is enabled', () => {
  const h = harness();
  h.enable();
  let calls = 0;
  const newVideo = { ...h.video, paused: true, currentTime: 0, play() { calls++; } };
  h.snapshot = { ...h.snapshot, key: '2.1 第二章', source: 'new.mp4', video: newVideo };
  h.advance(60000);
  assert.equal(h.controller.resumePending, null);
  assert.equal(calls, 0);
});

test('resume remains independent of the automatic next-video switch', () => {
  const h = harness();
  h.controller.configure({ enabled: false });
  h.enable();
  h.pause();
  h.advance(5000);
  assert.equal(h.controller.enabled, false);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.controller.pending?.resume, true);
  assert.equal(h.nextClicks, 0);
});

test('selecting infinity cancels both the countdown and resume-owned startup retries', async () => {
  const h = harness();
  h.enable();
  h.pause();
  h.advance(2000);
  h.controller.configure({ resumeDelay: 0 });
  h.advance(60000);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.controller.resumePending, null);

  h.enable();
  h.advance(5000);
  await flush();
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.controller.pending?.resume, true);
  h.controller.configure({ resumeDelay: 0 });
  h.advance(60000);
  await flush();
  assert.equal(h.controller.pending, null);
  assert.equal(h.video.playCalls, 1);
});

test('canceling this pause keeps the mode but waits for another actual playback episode', () => {
  const h = harness();
  h.enable();
  h.pause();
  h.controller.cancelResume();
  h.controller.onPaused(h.video);
  h.advance(60000);
  assert.equal(h.controller.resumeDelay, 5);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.controller.resumePending, null);
  h.playing();
  h.pause();
  assert.equal(h.controller.resumePending?.deadline, h.time + 5000);
  h.advance(5000);
  assert.equal(h.video.playCalls, 1);
});

test('playback resumed by the user cancels the pending timer', () => {
  const h = harness();
  h.enable();
  h.pause();
  h.advance(2000);
  h.playing();
  h.advance(10000);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.video.playCalls, 0);
});

for (const change of ['route', 'key', 'source', 'video']) {
  test(`changing ${change} cancels the old countdown without playing the replacement`, () => {
    const h = harness();
    h.enable();
    h.pause();
    let replacementCalls = 0;
    if (change === 'video') {
      h.snapshot = { ...h.snapshot, video: { ...h.video, play() { replacementCalls++; } } };
    } else {
      h.snapshot = { ...h.snapshot, [change]: `different-${change}` };
    }
    h.advance(5000);
    assert.equal(h.controller.resumePending, null);
    assert.equal(h.video.playCalls, 0);
    assert.equal(replacementCalls, 0);
    h.advance(60000);
    assert.equal(h.video.playCalls, 0);
    assert.equal(replacementCalls, 0);
  });
}

for (const state of ['hidden', 'modal', 'seeking', 'error', 'ended', 'near-end']) {
  test(`${state} cancels a pause countdown and clearing it does not silently rearm`, () => {
    const h = harness();
    h.enable();
    h.pause();
    h.advance(2000);
    if (state === 'hidden' || state === 'modal') h.snapshot = { ...h.snapshot, [state]: true };
    else if (state === 'near-end') h.video.currentTime = h.video.duration - 0.5;
    else h.video[state] = state === 'error' ? { code: 2 } : true;
    h.advance(1000);
    assert.equal(h.controller.resumePending, null);
    if (state === 'hidden' || state === 'modal') h.snapshot = { ...h.snapshot, [state]: false };
    else if (state === 'near-end') h.video.currentTime = 20;
    else h.video[state] = state === 'error' ? null : false;
    h.advance(60000);
    assert.equal(h.video.playCalls, 0);
    assert.equal(h.nextClicks, 0);
  });
}

test('a seeking event cancels the timer even when seeking has already settled before polling', () => {
  const h = harness();
  h.enable();
  h.pause();
  h.controller.onSeeking(h.video);
  h.advance(5000);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.video.playCalls, 0);
});

test('a pause that begins in the background does not start a timer on returning to the foreground', () => {
  const h = harness();
  h.enable();
  h.snapshot = { ...h.snapshot, hidden: true };
  h.pause();
  h.advance(6000);
  h.snapshot = { ...h.snapshot, hidden: false };
  h.advance(60000);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.video.playCalls, 0);
});

test('NotAllowedError is reported once and does not generate an endless five-second play loop', async () => {
  const h = harness({ result: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) });
  h.enable();
  h.pause();
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
  h.playing();
  h.pause();
  assert.ok(h.controller.resumePending, 'a later real playing then pause episode may try again');
});

test('a rejected timed resume keeps its playback help visible with automatic next disabled', async () => {
  const h = harness({ result: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) });
  h.controller.configure({ enabled: false, resumeDelay: 5 });
  h.pause();
  h.advance(5000); await flush();
  h.advance(500);
  assert.equal(h.frame.retry, true);
  assert.match(h.frame.message, /浏览器阻止了自动播放/);
  assert.equal(h.video.playCalls, 1);
});

test('resume startup supervision retries the same media at most three times and then stops', async () => {
  const h = harness();
  h.enable();
  h.pause();
  h.advance(5000);
  await flush();
  assert.equal(h.video.playCalls, 1);
  h.advance(3000); await flush();
  assert.equal(h.video.playCalls, 2);
  h.advance(3000); await flush();
  assert.equal(h.video.playCalls, 3);
  h.advance(54000); await flush();
  assert.equal(h.controller.pending, null);
  h.advance(600000); await flush();
  assert.equal(h.video.playCalls, 3);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.nextClicks, 0);
});

for (const state of ['seeking', 'ended', 'near-end']) {
  test(`${state} during resume startup stops any further automatic play attempts`, async () => {
    const h = harness();
    h.enable();
    h.pause();
    h.advance(5000);
    await flush();
    assert.equal(h.video.playCalls, 1);
    if (state === 'near-end') h.video.currentTime = h.video.duration - 0.5;
    else h.video[state] = true;
    h.advance(3000);
    assert.equal(h.controller.pending, null);
    if (state === 'near-end') h.video.currentTime = 20;
    else h.video[state] = false;
    h.advance(60000);
    await flush();
    assert.equal(h.video.playCalls, 1);
    assert.equal(h.controller.resumePending, null);
  });
}

test('turning timed resume off preserves an existing natural-end next-video countdown', () => {
  const h = harness();
  h.enable();
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.pause();
  h.controller.onEnded(h.video);
  h.advance(2000);
  h.controller.configure({ resumeDelay: 0 });
  assert.equal(h.controller.pending?.phase, 'countdown');
  h.advance(3000);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.nextClicks, 1);
});

test('natural video completion keeps normal auto-next and never restarts the completed video', () => {
  const h = harness();
  h.enable();
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.pause();
  h.controller.onEnded(h.video);
  assert.equal(h.controller.resumePending, null);
  assert.equal(h.controller.pending?.phase, 'countdown');
  h.advance(5000);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.nextClicks, 1);
});

test('a real ended event during resume startup hands back to normal next-video behavior', () => {
  const h = harness();
  h.enable();
  h.pause();
  h.advance(5000);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.controller.pending?.resume, true);
  h.video.currentTime = h.video.duration;
  h.video.ended = true;
  h.controller.onEnded(h.video);
  assert.equal(h.controller.pending?.phase, 'countdown');
  h.advance(5000);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.nextClicks, 1);
});
