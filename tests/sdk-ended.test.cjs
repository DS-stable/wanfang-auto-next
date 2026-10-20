'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EXTENSION = path.resolve(__dirname, '..');
// Optional local SDK fixture. Never downloaded or bundled with this repository.
const SDK = process.env.ALIPLAYER_SDK_PATH;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// This exercises the actual shipping MAIN script and isolated content script;
// the page-owned player only substitutes its SDK event emitter and media state.
function harness(t, { withPlayer = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="courseLearnBox">
    <div id="leftBox"><div class="tree-menu"><ul><li class="tree_item"><span class="firstSpan active"><span class="index">1.1</span><span class="tree-name">第一课</span></span></li></ul></div></div>
    <div id="rightBox"><div class="topBox"><div class="title_box"><h1>1.1 第一课</h1></div>
      <div class="in-player-panel"><div class="in-player" id="inPlayerTest"><video src="https://media.example/one.mp4"></video></div></div>
      <div class="progress-count"><div class="right"><span class="next" title="第二课"></span></div></div>
    </div></div></div></body>`, {
    url: 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=sdk-end-test',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const { document } = window;
  t.after(() => window.close());
  window.HTMLElement.prototype.getClientRects = function () {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || window.getComputedStyle(node).display === 'none') return [];
    }
    return [{ width: 10, height: 10 }];
  };
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  let now = 0;
  let timerId = 0;
  let clicks = 0;
  const timers = new Map();
  window.Date.now = () => now;
  window.setInterval = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay, interval: true, due: now + delay }); return id; };
  window.setTimeout = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, delay, interval: false, due: now + delay }); return id; };
  window.clearInterval = window.clearTimeout = id => timers.delete(id);
  window.chrome = { runtime: {}, storage: { local: {
    get: (_, callback) => callback({ wanfangEnabled: true, wanfangDelay: 5 }),
    set: (_, callback) => callback?.(),
  }, onChanged: { addListener() {} } } };
  document.querySelector('.next').addEventListener('click', () => clicks++);
  const states = new WeakMap();
  function prepare(video, source = 'https://media.example/one.mp4') {
    const state = { currentTime: 0, duration: 60, paused: false, ended: false, seeking: false, readyState: 4,
      error: null, source, playCalls: 0 };
    video.setAttribute('src', source);
    for (const name of ['currentTime', 'duration', 'paused', 'ended', 'seeking', 'readyState', 'error']) {
      Object.defineProperty(video, name, { get: () => state[name], configurable: true });
    }
    Object.defineProperty(video, 'currentSrc', { get: () => state.source, configurable: true });
    video.play = () => { state.playCalls++; state.paused = false; state.ended = false; return Promise.resolve(); };
    video.pause = () => { state.paused = true; video.dispatchEvent(new window.Event('pause')); };
    states.set(video, state);
    return video;
  }
  let currentVideo = prepare(document.querySelector('video'));
  const playerEvents = new WeakMap();
  function makePlayer(video = currentVideo) {
    const callbacks = new Map();
    const player = {
      tag: video,
      on(name, handler) { const list = callbacks.get(name) || new Set(); list.add(handler); callbacks.set(name, list); return this; },
      off(name, handler) { if (handler) callbacks.get(name)?.delete(handler); else callbacks.delete(name); return this; },
      emit(name) { for (const callback of [...(callbacks.get(name) || [])]) callback({ type: name }); },
      count(name) { return callbacks.get(name)?.size || 0; },
      _options: { isLive: false, rePlay: false },
      getCurrentTime: () => states.get(video).currentTime,
      getDuration: () => states.get(video).duration,
      pause: () => { video.pause(); return player; },
      trigger: name => player.emit(name),
    };
    playerEvents.set(player, callbacks);
    video.player = player;
    return player;
  }
  let currentPlayer = withPlayer ? makePlayer() : null;
  function evaluate(name) { window.eval(fs.readFileSync(path.join(EXTENSION, name), 'utf8')); }
  evaluate('player-bridge.js');
  evaluate('core.js');
  evaluate('content.js');
  const host = document.getElementById('wanfang-auto-next-extension');
  const $ = id => host.shadowRoot.getElementById(id);
  async function advance(ms = 500) {
    const target = now + ms;
    await flush();
    for (let count = 0; count < 10000; count++) {
      const due = Math.min(...[...timers.values()].map(timer => timer.due));
      if (due > target) break;
      now = due;
      for (const [id, timer] of [...timers]) {
        if (!timers.has(id) || timer.due > now) continue;
        if (timer.interval) timer.due = now + timer.delay; else timers.delete(id);
        timer.callback();
      }
      await flush();
    }
    now = target;
    await flush();
  }
  function replace() {
    const replacement = prepare(document.createElement('video'), 'https://media.example/two.mp4');
    currentVideo.replaceWith(replacement);
    currentVideo = replacement;
    currentPlayer = makePlayer();
    document.querySelector('h1').textContent = '1.2 第二课';
    document.querySelector('.next').title = '第三课';
    return replacement;
  }
  function finishSdk(overrides = {}) {
    Object.assign(states.get(currentVideo), { currentTime: 59.8, paused: true, ended: false, ...overrides });
    currentPlayer.emit('ended');
  }
  return { window, document, $, advance, replace, makePlayer, finishSdk,
    get video() { return currentVideo; }, get player() { return currentPlayer; },
    get state() { return states.get(currentVideo); }, get clicks() { return clicks; },
    get message() { return $('status').textContent; },
    attachPlayer() { currentPlayer = makePlayer(); return currentPlayer; },
  };
}

function officialModule(number, requireModule) {
  const sdk = fs.readFileSync(SDK, 'utf8');
  const prefix = `${number}:[function(e,t,r){`;
  const start = sdk.indexOf(prefix) + prefix.length;
  assert.ok(start >= prefix.length, `official module ${number} exists`);
  const end = sdk.indexOf('},{"', start);
  const moduleObject = { exports: {} };
  new Function('e', 't', 'r', sdk.slice(start, end))(requireModule, moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

test('official Aliplayer waiting/manualended reaches MAIN bridge and isolated controller', { skip: !SDK }, async t => {
  const h = harness(t);
  await h.advance();
  let nativeEnded = 0;
  let bridgeEnded = 0;
  h.video.addEventListener('ended', () => nativeEnded++);
  h.video.addEventListener('wanfang-auto-next-sdk-ended-v1', () => bridgeEnded++);
  const types = { Video: { ManualEnded: 'manualended' }, Private: { Play_Btn_Show: 'show' }, Player: { Ended: 'ended' } };
  const sdkEnded = officialModule(256, name => name.endsWith('/eventtype') ? types : {});
  const waiting = officialModule(263, name => {
    if (name.endsWith('/eventtype')) return types;
    if (name.endsWith('/event')) return { trigger: (tag, type) => {
      assert.equal(tag, h.video); assert.equal(type, 'manualended'); sdkEnded.handle.call(h.player, { type });
    } };
    return {};
  });
  h.state.currentTime = 59.8;
  waiting.handle.call(h.player, { type: 'waiting' });
  assert.equal(nativeEnded, 0);
  assert.equal(h.video.ended, false);
  assert.equal(h.player._ended, true);
  assert.equal(bridgeEnded, 1);
  assert.equal(h.$('cancel').hidden, false);
  assert.match(h.message, /^5 秒/);
  await h.advance(4999); assert.equal(h.clicks, 0);
  await h.advance(1); assert.equal(h.clicks, 1);
});

test('SDK and native duplicate completion cannot advance twice', async t => {
  const h = harness(t); await h.advance();
  assert.equal(h.player.count('ended'), 1);
  h.finishSdk(); h.finishSdk();
  h.state.ended = true;
  h.video.dispatchEvent(new h.window.Event('ended'));
  await h.advance(5000); await h.advance(1000);
  h.player.emit('ended'); await h.advance(6000);
  assert.equal(h.clicks, 1);
});

test('bridge discovers SDK instance attached after content installation', async t => {
  const h = harness(t, { withPlayer: false });
  await h.advance(); h.attachPlayer(); await h.advance();
  assert.equal(h.player.count('ended'), 1);
  h.finishSdk(); await h.advance(5000); assert.equal(h.clicks, 1);
});

test('bridge cleans removed video listeners and binds its replacement player once', async t => {
  const h = harness(t); await h.advance();
  const oldVideo = h.video; const oldPlayer = h.player;
  h.replace(); await h.advance();
  assert.equal(oldPlayer.count('ended'), 0);
  assert.equal(h.player.count('ended'), 1);
  oldPlayer.emit('ended'); oldVideo.dispatchEvent(new h.window.Event('wanfang-auto-next-sdk-ended-v1'));
  await h.advance(6000); assert.equal(h.clicks, 0);
  h.finishSdk(); await h.advance(5000); assert.equal(h.clicks, 1);
});

test('bridge cleans replaced SDK instance on the same video', async t => {
  const h = harness(t); await h.advance();
  const oldPlayer = h.player;
  h.attachPlayer(); await h.advance();
  assert.equal(oldPlayer.count('ended'), 0);
  assert.equal(h.player.count('ended'), 1);
  oldPlayer.emit('ended'); await h.advance(6000); assert.equal(h.clicks, 0);
  h.finishSdk(); await h.advance(5000); assert.equal(h.clicks, 1);
});

test('mismatched player.tag is never subscribed', async t => {
  const h = harness(t, { withPlayer: false });
  const otherVideo = h.document.createElement('video');
  const mismatched = h.makePlayer(otherVideo);
  h.video.player = mismatched;
  await h.advance(); assert.equal(mismatched.count('ended'), 0);
});

test('405/1085 mid-video pause and early SDK notification do not advance', async t => {
  const h = harness(t); await h.advance();
  Object.assign(h.state, { duration: 1085.034667, currentTime: 405.926336, paused: true });
  h.video.dispatchEvent(new h.window.Event('pause'));
  await h.advance(10000); assert.equal(h.clicks, 0); assert.equal(h.$('cancel').hidden, true);
  h.player.emit('ended'); await h.advance(10000); assert.equal(h.clicks, 0);
});

test('manual pause in final fraction without SDK ended never advances', async t => {
  const h = harness(t); await h.advance();
  Object.assign(h.state, { currentTime: 59.8, paused: true });
  h.video.dispatchEvent(new h.window.Event('timeupdate'));
  h.video.dispatchEvent(new h.window.Event('pause'));
  await h.advance(20000); assert.equal(h.clicks, 0); assert.equal(h.$('cancel').hidden, true);
});

test('replaying or seeking after SDK end cancels pending navigation', async t => {
  for (const mode of ['playing', 'seeking', 'seeked backwards']) await t.test(mode, async st => {
    const h = harness(st); await h.advance(); h.finishSdk();
    assert.equal(h.$('cancel').hidden, false);
    if (mode === 'playing') { h.state.paused = false; h.video.dispatchEvent(new h.window.Event('playing')); }
    if (mode === 'seeking') { h.state.seeking = true; h.video.dispatchEvent(new h.window.Event('seeking')); }
    if (mode === 'seeked backwards') { h.state.currentTime = 30; h.video.dispatchEvent(new h.window.Event('seeked')); }
    await h.advance(5000); assert.equal(h.clicks, 0); assert.equal(h.$('cancel').hidden, true);
  });
});

test('SDK notification requires finite complete media, paused state, and no media error', async t => {
  const cases = [
    ['media error', { error: { code: 3 } }], ['early notification', { currentTime: 30 }],
    ['still playing', { paused: false }], ['seeking', { seeking: true }],
    ['unknown duration', { duration: NaN }], ['infinite duration', { duration: Infinity }],
    ['unknown position', { currentTime: NaN }],
  ];
  for (const [name, overrides] of cases) await t.test(name, async st => {
    const h = harness(st); await h.advance(); h.finishSdk(overrides); await h.advance(6000);
    assert.equal(h.clicks, 0); assert.equal(h.$('cancel').hidden, true);
  });
});

test('source or lesson changes invalidate SDK completion countdown', async t => {
  for (const mode of ['source', 'lesson']) await t.test(mode, async st => {
    const h = harness(st); await h.advance(); h.finishSdk();
    if (mode === 'source') { h.state.source = 'https://media.example/other.mp4'; h.video.setAttribute('src', h.state.source); }
    else h.document.querySelector('h1').textContent = '1.3 第三课';
    await h.advance(5000); assert.equal(h.clicks, 0);
  });
});
