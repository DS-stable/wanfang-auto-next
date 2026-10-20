'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const core = require('../core.js');

const COURSE_URL = 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=test-course';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function makeHarness() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <span class="next" title="Outside next">irrelevant</span>
    <div id="courseLearnBox"><div id="courseLearn">
      <div id="leftBox"><div class="tree-menu"><ul>
        <li class="tree_item outerLi"><span class="firstSpan font15"><span class="course-index">1</span><span class="tree-name">章节</span></span>
          <ul class="childUl"><li class="tree_item"><span class="firstSpan active font13"><span class="index">1.1</span><span class="tree-name">第一课</span></span></li></ul>
        </li></ul></div></div>
      <div id="rightBox"><div class="topBox">
        <div class="title_box"><h1>1.1 第一课</h1></div>
        <div class="in-player-panel"><div class="in-player" id="inPlayer123"><video src="https://media.example/one.mp4"></video></div></div>
        <div class="progress-count"><div class="right"><span class="last-no-active"></span><span class="next" title="第二课"><img alt=""></span></div></div>
      </div></div>
    </div></div>
  </body></html>`, { url: COURSE_URL, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  window.HTMLElement.prototype.getClientRects = function () {
    let element = this;
    while (element) {
      if (element.hidden || window.getComputedStyle(element).display === 'none') return [];
      element = element.parentElement;
    }
    return [{ width: 10, height: 10 }];
  };
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
  let time = 0;
  let clicks = 0;
  const frames = [];
  const states = new WeakMap();
  function prepareVideo(video, source = 'https://media.example/one.mp4', overrides = {}) {
    const state = { ended: false, duration: 60, currentTime: 0, readyState: 2, paused: false,
      source, playCalls: 0, playResult: null, ...overrides };
    video.setAttribute('src', source);
    for (const name of ['ended', 'duration', 'currentTime', 'readyState', 'paused']) {
      Object.defineProperty(video, name, { get: () => state[name], configurable: true });
    }
    Object.defineProperty(video, 'currentSrc', { get: () => state.source, configurable: true });
    video.play = function () {
      state.playCalls += 1;
      if (state.playResult) return state.playResult();
      state.paused = false;
      state.ended = false;
      return Promise.resolve();
    };
    states.set(video, state);
    return video;
  }
  prepareVideo(document.querySelector(core.SELECTORS.video));
  document.querySelector(core.SELECTORS.next).addEventListener('click', () => { clicks += 1; });
  const controller = new core.Controller({ read: () => core.readSnapshot(document, window.location),
    render: frame => frames.push(frame), now: () => time });
  function video() { return document.querySelector(core.SELECTORS.video); }
  function state() { return states.get(video()); }
  function ended() {
    Object.assign(state(), { ended: true, currentTime: state().duration, paused: true });
    controller.onEnded(video());
  }
  function replaceVideo(title = '1.2 第二课', source = 'https://media.example/two.mp4', overrides = {}) {
    document.querySelector(core.SELECTORS.title).textContent = title;
    const previous = video();
    const replacement = prepareVideo(document.createElement('video'), source, overrides);
    if (previous) previous.replaceWith(replacement);
    else document.querySelector('.in-player').append(replacement);
    return replacement;
  }
  function advance(ms) { time += ms; controller.tick(); }
  return { dom, window, document, controller, frames, prepareVideo, replaceVideo, ended, advance,
    video, state, get clicks() { return clicks; }, get frame() { return frames.at(-1); },
    get now() { return time; }, set visibility(value) { visibility = value; } };
}

function beginSwitch(h) {
  h.ended();
  h.advance(5000);
  assert.equal(h.clicks, 1);
  assert.equal(h.controller.pending?.phase, 'switching');
}

// Verifies the selectors against the public Vue render-function DOM shape.
test('readSnapshot uses the actual quality-course layout and scoped next control', () => {
  const h = makeHarness();
  const snapshot = core.readSnapshot(h.document, h.window.location);
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.title, '1.1 第一课');
  assert.equal(snapshot.nextTitle, '第二课');
  assert.equal(snapshot.source, 'https://media.example/one.mp4');
  assert.equal(snapshot.hidden, false);
  assert.equal(snapshot.modal, false);
  assert.equal(snapshot.nonVideo, false);
  assert.equal(snapshot.video, h.video());
});

test('a natural ended event starts a 5-second countdown and clicks only once', () => {
  const h = makeHarness();
  h.ended();
  assert.equal(h.frame.countdown, true);
  assert.match(h.frame.message, /^5 秒/);
  h.advance(4999);
  assert.equal(h.clicks, 0);
  h.advance(1);
  assert.equal(h.clicks, 1);
  for (let count = 0; count < 5; count += 1) {
    h.controller.onEnded(h.video());
    h.advance(1000);
  }
  assert.equal(h.clicks, 1);
});

test('non-ended, incomplete, unsupported, disabled and stale-video events are rejected', async t => {
  const cases = [
    ['not ended', h => { Object.assign(h.state(), { ended: false, currentTime: 60 }); }],
    ['not at end', h => { Object.assign(h.state(), { ended: true, currentTime: 10 }); }],
    ['zero duration', h => { Object.assign(h.state(), { ended: true, duration: 0 }); }],
    ['infinite duration', h => { Object.assign(h.state(), { ended: true, duration: Infinity }); }],
    ['missing source', h => { Object.assign(h.state(), { ended: true, currentTime: 60, source: '' }); h.video().removeAttribute('src'); }],
    ['missing title', h => { Object.assign(h.state(), { ended: true, currentTime: 60 }); h.document.querySelector(core.SELECTORS.title).textContent = ''; }],
    ['unsupported route', h => { Object.assign(h.state(), { ended: true, currentTime: 60 }); h.window.history.replaceState({}, '', '/e-training/quality/list'); }],
    ['disabled', h => { Object.assign(h.state(), { ended: true, currentTime: 60 }); h.controller.configure({ enabled: false }); }],
  ];
  for (const [name, setup] of cases) await t.test(name, () => {
    const h = makeHarness(); setup(h); h.controller.onEnded(h.video()); h.advance(6000);
    assert.equal(h.clicks, 0);
    assert.equal(h.controller.pending, null);
  });
  const h = makeHarness();
  const stale = h.video();
  h.replaceVideo();
  h.controller.onEnded(stale);
  assert.equal(h.controller.pending, null);
});

test('cancelling the countdown prevents duplicate ended from scheduling the same completion again', () => {
  const h = makeHarness(); h.ended(); h.advance(1000); h.controller.cancel();
  h.controller.onEnded(h.video()); h.advance(10000);
  assert.equal(h.clicks, 0);
  assert.equal(h.controller.pending, null);
  assert.match(h.frame.message, /已取消/);
});

test('turning the extension off cancels countdown and re-enabling does not resume it', () => {
  const h = makeHarness(); h.ended(); h.advance(1000); h.controller.configure({ enabled: false });
  h.advance(10000); assert.equal(h.clicks, 0); assert.match(h.frame.message, /已关闭/);
  h.controller.configure({ enabled: true }); h.controller.onEnded(h.video()); h.advance(10000);
  assert.equal(h.clicks, 0);
});

test('manual lesson change during countdown cancels the operation', () => {
  const h = makeHarness(); h.ended(); h.advance(1000); h.replaceVideo('1.3 第三课', 'https://media.example/three.mp4');
  h.advance(6000);
  assert.equal(h.clicks, 0);
  assert.equal(h.controller.pending, null);
  assert.equal(h.state().playCalls, 0);
});

test('route change during countdown cancels the operation', () => {
  const h = makeHarness(); h.ended(); h.window.history.replaceState({}, '', '?courseId=another-course');
  h.advance(6000); assert.equal(h.clicks, 0); assert.equal(h.controller.pending, null);
});

test('background or modal prevents scheduling and cancels an existing countdown', async t => {
  for (const mode of ['background', 'modal']) {
    for (const stage of ['before end', 'during countdown']) await t.test(`${mode}: ${stage}`, () => {
      const h = makeHarness();
      if (stage === 'during countdown') { h.ended(); h.advance(1000); }
      if (mode === 'background') h.visibility = 'hidden';
      else {
        const modal = h.document.createElement('div'); modal.className = 'el-message-box__wrapper'; h.document.body.append(modal);
      }
      if (stage === 'before end') h.ended();
      else h.controller.tick();
      h.advance(10000); assert.equal(h.clicks, 0); assert.equal(h.controller.pending, null);
      assert.match(h.frame.message, mode === 'background' ? /前台/ : /处理页面上的提示/);
    });
  }
});

test('hidden Element UI dialog does not block a natural completion', () => {
  const h = makeHarness();
  const modal = h.document.createElement('div'); modal.className = 'el-dialog__wrapper'; modal.style.display = 'none'; h.document.body.append(modal);
  h.ended(); h.advance(5000); assert.equal(h.clicks, 1);
});

test('last lesson and missing next control stop with appropriate notices', async t => {
  await t.test('last lesson', () => {
    const h = makeHarness(); const next = h.document.querySelector(core.SELECTORS.next); next.className = 'next-no-active';
    h.ended(); h.advance(6000); assert.equal(h.clicks, 0); assert.match(h.frame.message, /最后一节/);
  });
  await t.test('missing next', () => {
    const h = makeHarness(); h.document.querySelector(core.SELECTORS.next).remove();
    h.ended(); h.advance(6000); assert.equal(h.clicks, 0); assert.match(h.frame.message, /未找到/);
  });
});

test('recreated next video waits for initialization and then starts exactly once', async () => {
  const h = makeHarness(); beginSwitch(h);
  h.replaceVideo('1.2 第二课', 'https://media.example/two.mp4', { paused: true });
  h.controller.tick(); assert.equal(h.state().playCalls, 0);
  h.advance(499); assert.equal(h.state().playCalls, 0);
  h.advance(1); assert.equal(h.state().playCalls, 1);
  await flush();
  assert.equal(h.controller.pending, null);
  assert.equal(h.frame.retry, false);
  assert.match(h.frame.message, /正在播放/);
  h.controller.tick(); assert.equal(h.state().playCalls, 1);
});

test('NotAllowedError exposes manual retry, and retry synchronously invokes play', async () => {
  const h = makeHarness(); beginSwitch(h);
  h.replaceVideo('1.2 第二课', 'https://media.example/two.mp4', { paused: true,
    playResult: () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) });
  h.controller.tick(); h.advance(500); await flush();
  assert.equal(h.controller.pending, null);
  assert.equal(h.frame.retry, true);
  assert.match(h.frame.message, /浏览器阻止了自动播放/);
  h.state().playResult = null;
  const oldCalls = h.state().playCalls;
  h.controller.playCurrent(); assert.equal(h.state().playCalls, oldCalls + 1);
  await flush(); assert.equal(h.frame.retry, false); assert.match(h.frame.message, /正在播放/);
});

test('the next item being quiz or document stops without trying to play', async t => {
  for (const kind of ['quiz', 'document']) await t.test(kind, () => {
    const h = makeHarness(); beginSwitch(h);
    h.document.querySelector(core.SELECTORS.title).textContent = kind === 'quiz' ? '随堂测验 共3题' : '1.2 讲义';
    h.video().remove();
    const item = h.document.createElement('div');
    if (kind === 'quiz') item.className = 'quiz'; else item.id = 'blank';
    h.document.querySelector('.topBox').append(item);
    h.controller.tick(); assert.equal(h.controller.pending, null); assert.equal(h.frame.retry, false);
    assert.match(h.frame.message, /测验或文档/); assert.equal(h.clicks, 1);
  });
});

test('switch timeout does not click again and gives a manual recovery state', () => {
  const h = makeHarness(); beginSwitch(h); h.advance(24999);
  assert.equal(h.controller.pending?.phase, 'switching');
  h.advance(1); assert.equal(h.controller.pending, null); assert.match(h.frame.message, /超时/);
  assert.equal(h.frame.retry, true); h.advance(100000); assert.equal(h.clicks, 1);
});

test('changing or disabling next control during countdown cancels rather than guessing', () => {
  const h = makeHarness(); h.ended(); h.document.querySelector(core.SELECTORS.next).title = '第三课';
  h.advance(5000); assert.equal(h.clicks, 0); assert.equal(h.controller.pending, null); assert.match(h.frame.message, /按钮发生变化/);
});

test('manual lesson change while the next lesson is loading must not start that unrelated lesson', async () => {
  const h = makeHarness(); beginSwitch(h);
  h.replaceVideo('1.3 第三课', 'https://media.example/three.mp4', { paused: true });
  h.controller.tick(); h.advance(500); await flush();
  assert.equal(h.state().playCalls, 0, 'manual selection of a different lesson should cancel the pending automatic play');
  assert.equal(h.controller.pending, null);
});

function installContent(h, { settings = {}, deferGet = false, storageThrows = false } = {}) {
  const fs = require('node:fs');
  let time = 0;
  let getter = null;
  const writes = [];
  const changes = [];
  const intervals = [];
  const timeouts = [];
  const { window } = h;
  window.Date.now = () => time;
  window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  window.setTimeout = (callback, delay) => { timeouts.push({ callback, due: time + delay }); return timeouts.length; };
  window.chrome = {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get(keys, callback) {
          if (storageThrows) throw new Error('extension context invalidated');
          assert.deepEqual([...keys], ['wanfangEnabled', 'wanfangDelay', 'wanfangResumeDelay']);
          if (deferGet) getter = callback; else callback(settings);
        },
        set(values, callback) { writes.push(JSON.parse(JSON.stringify(values))); callback?.(); },
      },
      onChanged: { addListener(callback) { changes.push(callback); } },
    },
  };
  window.eval(fs.readFileSync(require.resolve('../core.js'), 'utf8'));
  window.eval(fs.readFileSync(require.resolve('../content.js'), 'utf8'));
  const host = h.document.getElementById('wanfang-auto-next-extension');
  const $ = id => host.shadowRoot.getElementById(id);
  async function advance(ms = 500) {
    time += ms;
    for (const timer of timeouts.splice(0)) {
      if (timer.due <= time) timer.callback(); else timeouts.push(timer);
    }
    for (const callback of intervals) callback();
    await flush();
  }
  function nativeEnd() {
    Object.assign(h.state(), { ended: true, currentTime: h.state().duration, paused: true });
    h.video().dispatchEvent(new window.Event('ended'));
  }
  return { $, host, writes, changes, advance, nativeEnd,
    finishGet(value = settings) { getter(value); },
    changed(value, area = 'local') { changes.forEach(callback => callback(value, area)); } };
}

test('content integration restores and persists chrome.storage preferences and responds to changes', async t => {
  const h = makeHarness(); t.after(() => h.window.close());
  const ui = installContent(h, { settings: { wanfangEnabled: false, wanfangDelay: 10 } });
  assert.equal(ui.host.style.display, 'block');
  assert.equal(ui.$('toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.$('delay').value, '10');
  ui.nativeEnd(); await ui.advance(10000); assert.equal(h.clicks, 0);
  ui.$('toggle').click();
  assert.equal(ui.$('toggle').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(ui.writes.at(-1), { wanfangEnabled: true, wanfangDelay: 10, wanfangResumeDelay: 0 });
  ui.$('delay').value = '3'; ui.$('delay').dispatchEvent(new h.window.Event('change'));
  assert.deepEqual(ui.writes.at(-1), { wanfangEnabled: true, wanfangDelay: 3, wanfangResumeDelay: 0 });
  ui.changed({ wanfangEnabled: { newValue: false }, wanfangDelay: { newValue: 5 } });
  assert.equal(ui.$('toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.$('delay').value, '5');
  ui.$('collapse').click(); assert.equal(ui.$('compact').hidden, false);
  ui.$('compact').click(); assert.equal(ui.$('compact').hidden, true);
});

test('content integration waits for preferences, binds native ended and rebinds replacement video', async t => {
  const h = makeHarness(); t.after(() => h.window.close());
  const ui = installContent(h, { deferGet: true });
  ui.nativeEnd(); await ui.advance(5000); assert.equal(h.clicks, 0);
  ui.finishGet({ wanfangEnabled: true, wanfangDelay: 5 });
  ui.nativeEnd(); assert.equal(ui.$('cancel').hidden, false); assert.match(ui.$('status').textContent, /^5 秒/);
  await ui.advance(4999); assert.equal(h.clicks, 0);
  await ui.advance(1); assert.equal(h.clicks, 1);
  const oldVideo = h.video();
  h.replaceVideo('1.2 第二课', 'https://media.example/two.mp4', { paused: true });
  await flush(); await ui.advance(500); await ui.advance(500);
  assert.equal(h.state().playCalls, 1);
  assert.match(ui.$('status').textContent, /正在播放/);
  oldVideo.dispatchEvent(new h.window.Event('ended'));
  assert.equal(ui.$('cancel').hidden, true, 'an old removed video must not schedule a transition');
  h.document.querySelector(core.SELECTORS.next).title = '第三课';
  ui.nativeEnd(); assert.equal(ui.$('cancel').hidden, false, 'replacement video must have an ended listener');
  await ui.advance(5000); assert.equal(h.clicks, 2);
});

test('content integration cancellation button stops pending native-ended countdown', async t => {
  const h = makeHarness(); t.after(() => h.window.close());
  const ui = installContent(h);
  ui.nativeEnd(); assert.equal(ui.$('cancel').hidden, false);
  ui.$('cancel').click(); assert.equal(ui.$('cancel').hidden, true);
  await ui.advance(6000); assert.equal(h.clicks, 0); assert.match(ui.$('status').textContent, /已取消/);
});

test('content integration remains usable when Chrome preference access throws', async t => {
  const h = makeHarness(); t.after(() => h.window.close());
  const ui = installContent(h, { storageThrows: true });
  assert.equal(ui.$('toggle').getAttribute('aria-pressed'), 'true');
  ui.nativeEnd(); await ui.advance(5000); assert.equal(h.clicks, 1);
});

test('timed resume button defaults to infinity and persists the selected 5-second mode', async t => {
  const h = makeHarness(); t.after(() => h.window.close());
  const ui = installContent(h);
  assert.equal(ui.$('resume-controls').hidden, false);
  assert.equal(ui.$('resume-toggle').textContent, '定时续播：∞');
  Object.assign(h.state(), { paused: true, currentTime: 10 });
  h.video().dispatchEvent(new h.window.Event('pause'));
  await ui.advance(10000);
  assert.equal(h.state().playCalls, 0, 'infinity preserves the original paused state');
  ui.$('resume-toggle').click();
  assert.equal(ui.$('resume-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.writes.at(-1).wanfangResumeDelay, 5);
  assert.equal(ui.$('resume-cancel').hidden, false);
  assert.match(ui.$('resume-status').textContent, /5 秒后继续播放/);
  await ui.advance(4999); assert.equal(h.state().playCalls, 0);
  await ui.advance(1); assert.equal(h.state().playCalls, 1);
  assert.equal(ui.$('resume-cancel').hidden, true);
  ui.$('resume-toggle').click();
  assert.equal(ui.writes.at(-1).wanfangResumeDelay, 0);
});

test('timed resume UI cancellation and storage changes stop pending play', async t => {
  const h = makeHarness(); t.after(() => h.window.close());
  Object.assign(h.state(), { paused: true, currentTime: 10 });
  const ui = installContent(h, { settings: { wanfangResumeDelay: 5 } });
  assert.equal(ui.$('resume-cancel').hidden, false);
  ui.$('resume-cancel').click();
  await ui.advance(6000); assert.equal(h.state().playCalls, 0);
  assert.match(ui.$('resume-status').textContent, /已取消本次续播/);
  ui.changed({ wanfangResumeDelay: { newValue: 0 } });
  assert.equal(ui.$('resume-toggle').textContent, '定时续播：∞');
  ui.changed({ wanfangResumeDelay: { newValue: 5 } });
  assert.equal(ui.$('resume-cancel').hidden, false);
  ui.changed({ wanfangResumeDelay: { newValue: 0 } });
  await ui.advance(6000); assert.equal(h.state().playCalls, 0);
  assert.equal(ui.$('resume-cancel').hidden, true);
});
