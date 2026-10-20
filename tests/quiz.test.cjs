'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const core = require('../core.js');
const URL = 'https://cx.wanfangdata.com.cn/e-training/quality/courselearn?courseId=quiz-test';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function makeHarness(t, { done = false, collapsed = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="courseLearnBox"><div id="courseLearn">
      <div id="leftBox"><div class="tree-menu">
        <ul><li class="tree_item outerLi"><span class="firstSpan"><span class="course-index">1</span><span class="tree-name">第一章</span></span>
          <ul class="childUl">
            <li class="tree_item"><span class="firstSpan"><span class="index">1.1</span><span class="tree-name">前一视频</span><img style="right:-26px;width:15px" src="done.png"></span></li>
            <li class="tree_item"><span id="quiz-one" class="firstSpan active"><img style="left:7px;width:14px" src="/img/stcy.bf94dfa1.png"><span>随堂测验</span></span></li>
          </ul>
        </li></ul>
        <ul><li class="tree_item outerLi"><span id="chapter-two" class="firstSpan"><span class="course-index">2</span><span class="tree-name">第二章</span></span>
          <ul class="childUl" ${collapsed ? 'style="display:none"' : ''}>
            <li class="tree_item"><span id="pdf" class="firstSpan"><img style="left:5px;width:15px" src="data:image/png;base64,pdf"><span class="index">2.1</span><span class="tree-name">课程讲义</span></span></li>
            <li class="tree_item"><span id="disabled" aria-disabled="true" class="firstSpan"><span class="index">2.2</span><span class="tree-name">不可用视频</span></span></li>
            <li class="tree_item"><span id="destination" class="firstSpan"><span class="index">2.3</span><span class="tree-name">下个视频</span></span></li>
            <li class="tree_item"><span id="quiz-two" class="firstSpan"><img style="left:5px;width:18px" src="/img/stcy-gray.11a251ff.png"><span>随堂测验</span></span></li>
            <li class="tree_item"><span id="third-video" class="firstSpan"><span class="index">2.5</span><span class="tree-name">再下个视频</span></span></li>
          </ul>
        </li></ul>
        <ul><li id="exam"><span>考试测评</span></li></ul>
      </div></div>
      <div id="rightBox"><div class="topBox"><div class="title_box"><h1>随堂测验 共1题</h1></div><div class="quiz"></div></div></div>
    </div></div>
  </body>`, { url: URL, runScripts: 'outside-only' });
  const { window } = dom;
  const { document } = window;
  t.after(() => window.close());
  window.HTMLElement.prototype.getClientRects = function () {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || window.getComputedStyle(node).display === 'none') return [];
    }
    return [{ width: 10, height: 10 }];
  };
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
  let time = 0;
  const frames = [];
  const clicked = [];
  const expanded = [];
  const videoStates = new WeakMap();
  function setActive(id) {
    for (const node of document.querySelectorAll('.firstSpan.active')) node.classList.remove('active');
    document.getElementById(id).classList.add('active');
  }
  function setQuiz({ key = '1.2', done = false, active = 'quiz-one' } = {}) {
    const box = document.querySelector('.topBox');
    box.querySelectorAll('.in-player-panel, #blank').forEach(node => node.remove());
    if (!box.querySelector('.quiz')) box.insertAdjacentHTML('beforeend', '<div class="quiz"></div>');
    document.querySelector(core.SELECTORS.title).textContent = '随堂测验 共1题';
    document.querySelector('.quiz').innerHTML = `<div><div class="quiz-ques"><span id="quiz_warning_${key}.0" style="visibility:hidden">*</span>题目</div><div class="quiz-options ${done ? 'right' : ''}"><input type="checkbox" ${done ? 'disabled' : ''}></div>${done ? '<div class="answer">正确答案：A</div><div class="analyzing">解析</div>' : ''}</div><button class="submit">${done ? '重新测验' : '提交答案'}</button>`;
    setActive(active);
  }
  function complete() {
    const button = document.querySelector('.quiz button.submit');
    button.textContent = '重新测验';
    document.querySelector('.quiz > div').insertAdjacentHTML('beforeend', '<div class="answer">正确答案：A</div><div class="analyzing">解析</div>');
    document.querySelector('.quiz input').disabled = true;
  }
  function showVideo(id = 'destination', { source, title, activate = id } = {}) {
    const node = document.getElementById(id);
    setActive(activate);
    const label = node.querySelector('.index').textContent + ' ' + node.querySelector('.tree-name').textContent;
    document.querySelector(core.SELECTORS.title).textContent = title || label;
    document.querySelector('.quiz')?.remove();
    document.querySelector('.in-player-panel')?.remove();
    const panel = document.createElement('div'); panel.className = 'in-player-panel';
    const video = document.createElement('video'); video.src = source || `https://media.example/${id}.mp4`;
    const state = { currentTime: 0, duration: 60, paused: true, ended: false, readyState: 2, playCalls: 0 };
    for (const property of ['currentTime', 'duration', 'paused', 'ended', 'readyState']) {
      Object.defineProperty(video, property, { get: () => state[property], configurable: true });
    }
    Object.defineProperty(video, 'currentSrc', { get: () => video.getAttribute('src'), configurable: true });
    video.play = () => { state.playCalls += 1; state.paused = false; return Promise.resolve(); };
    panel.append(video); document.querySelector('.topBox').append(panel);
    videoStates.set(video, state);
    return { video, state };
  }
  for (const id of ['destination', 'third-video', 'pdf', 'disabled', 'exam']) {
    document.getElementById(id).addEventListener('click', () => clicked.push(id));
  }
  document.getElementById('chapter-two').addEventListener('click', () => {
    const children = document.getElementById('chapter-two').parentElement.querySelector(':scope > ul.childUl');
    children.style.display = children.style.display === 'none' ? '' : 'none'; expanded.push('chapter-two');
  });
  setQuiz({ done });
  const controller = new core.Controller({ read: () => core.readSnapshot(document, window.location), render: frame => frames.push(frame), now: () => time });
  function advance(ms) { time += ms; controller.tick(); }
  return { dom, window, document, controller, frames, clicked, expanded, setQuiz, complete, showVideo, setActive, advance,
    snapshot: () => core.readSnapshot(document, window.location), get frame() { return frames.at(-1); },
    set visibility(value) { visibility = value; } };
}

function submitSuccessfully(h) {
  h.controller.tick();
  h.complete(); h.controller.tick();
  assert.equal(h.controller.pending?.kind, 'quiz');
  assert.equal(h.controller.pending?.phase, 'countdown');
}

test('quiz snapshot scopes success markers and derives distinct warning-id keys', t => {
  const h = makeHarness(t);
  assert.equal(h.snapshot().key, 'quiz:1.2');
  assert.equal(h.snapshot().quiz, true);
  assert.equal(h.snapshot().quizDone, false);
  assert.equal(h.snapshot().directoryNext.title, '2.3 下个视频');
  const stray = h.document.createElement('div'); stray.innerHTML = '<button class="submit">重新测验</button><div class="answer">A</div>'; h.document.body.append(stray);
  assert.equal(h.snapshot().quizDone, false);
  h.complete(); assert.equal(h.snapshot().quizDone, true);
  h.document.querySelector('.quiz .answer').remove(); assert.equal(h.snapshot().quizDone, false);
  h.setQuiz({ key: '2.4', done: false, active: 'quiz-two' }); assert.equal(h.snapshot().key, 'quiz:2.4');
});

test('initially completed quiz does not navigate and offers manual continuation', t => {
  const h = makeHarness(t, { done: true }); h.controller.tick(); h.advance(20000);
  assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null); assert.equal(h.frame.canContinue, true);
  assert.match(h.frame.message, /可点击/);
});

test('submit click without server-confirmed success never starts navigation', t => {
  const h = makeHarness(t); h.controller.tick(); h.document.querySelector('.submit').click(); h.advance(30000);
  assert.equal(h.controller.pending, null); assert.deepEqual(h.clicked, []);
});

test('confirmed submission counts down five seconds, navigates once, then plays target once', async t => {
  const h = makeHarness(t); submitSuccessfully(h);
  h.advance(4999); assert.deepEqual(h.clicked, []);
  h.advance(1); assert.deepEqual(h.clicked, ['destination']); assert.equal(h.controller.pending.phase, 'switching');
  h.controller.tick(); h.advance(100); assert.deepEqual(h.clicked, ['destination']);
  const { state } = h.showVideo(); h.controller.tick(); h.advance(499); assert.equal(state.playCalls, 0);
  h.advance(1); assert.equal(state.playCalls, 1); await flush(); assert.equal(h.controller.pending, null);
  h.advance(10000); assert.equal(state.playCalls, 1); assert.deepEqual(h.clicked, ['destination']);
});

test('cancelling a quiz countdown prevents repeat navigation on later ticks', t => {
  const h = makeHarness(t); submitSuccessfully(h); h.controller.cancel(); h.advance(20000);
  assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null); assert.equal(h.frame.canContinue, true);
});

test('turning auto off cancels quiz countdown and re-enabling does not restart it', t => {
  const h = makeHarness(t); submitSuccessfully(h); h.controller.configure({ enabled: false }); h.advance(10000);
  h.controller.configure({ enabled: true }); h.advance(10000); assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null);
});

test('completion observed while auto is off does not start when enabled later', t => {
  const h = makeHarness(t); h.controller.configure({ enabled: false }); h.complete(); h.controller.tick(); h.advance(10000);
  h.controller.configure({ enabled: true }); h.advance(10000); assert.deepEqual(h.clicked, []);
});

test('background or modal prevents quiz scheduling and cancels scheduled switch', async t => {
  for (const mode of ['background', 'modal']) for (const stage of ['before success', 'during countdown']) await t.test(`${mode}, ${stage}`, st => {
    const h = makeHarness(st); h.controller.tick();
    if (stage === 'during countdown') { h.complete(); h.controller.tick(); }
    if (mode === 'background') h.visibility = 'hidden';
    else h.document.body.insertAdjacentHTML('beforeend', '<div class="el-message-box__wrapper">提示</div>');
    if (stage === 'before success') h.complete();
    h.controller.tick(); h.advance(10000); assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null);
    h.visibility = 'visible'; h.document.querySelector('.el-message-box__wrapper')?.remove(); h.advance(10000); assert.deepEqual(h.clicked, []);
  });
});

test('retrying the quiz cancels its countdown, and fresh submission can schedule again', t => {
  const h = makeHarness(t); submitSuccessfully(h); h.setQuiz(); h.controller.tick(); h.advance(10000);
  assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null); assert.match(h.frame.message, /重新开始/);
  h.complete(); h.controller.tick(); h.advance(5000); assert.deepEqual(h.clicked, ['destination']);
});

test('switching courses or another quiz with the same heading cancels pending navigation', async t => {
  for (const mode of ['course', 'quiz']) await t.test(mode, st => {
    const h = makeHarness(st); submitSuccessfully(h);
    if (mode === 'course') h.window.history.replaceState({}, '', '?courseId=another-course');
    else h.setQuiz({ key: '2.4', active: 'quiz-two' });
    h.advance(5000); assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null);
  });
});

test('another already-completed quiz sharing title does not imitate a fresh submission', t => {
  const h = makeHarness(t); h.controller.tick(); h.setQuiz({ key: '2.4', done: true, active: 'quiz-two' }); h.controller.tick(); h.advance(10000);
  assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null);
});

test('directory traversal skips documents and disabled lessons and excludes exam rows', t => {
  const h = makeHarness(t); const directory = core.readDirectory(h.document);
  assert.equal(directory.next.key, '2.3'); assert.equal(directory.next.kind, 'video'); assert.equal(directory.next.node.id, 'destination');
  h.setActive('third-video'); assert.equal(core.readDirectory(h.document).next, null);
});

test('folded chapter is discovered and expanded before clicking video leaf', t => {
  const h = makeHarness(t, { collapsed: true }); submitSuccessfully(h);
  h.document.getElementById('destination').addEventListener('click', () => {
    assert.notEqual(h.window.getComputedStyle(h.document.querySelector('#chapter-two + ul')).display, 'none');
  });
  h.advance(5000); assert.deepEqual(h.expanded, ['chapter-two']); assert.deepEqual(h.clicked, ['destination']);
});

test('mutated directory target during countdown cancels without selecting another video', t => {
  const h = makeHarness(t); submitSuccessfully(h); h.document.getElementById('destination').setAttribute('aria-disabled', 'true'); h.advance(5000);
  assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null); assert.match(h.frame.message, /变化/);
});

test('same video title with a mismatched active directory key is never autoplayed', async t => {
  const h = makeHarness(t); submitSuccessfully(h); h.advance(5000);
  const { state } = h.showVideo('third-video', { title: '2.3 下个视频' }); h.controller.tick(); h.advance(1000); await flush();
  assert.equal(state.playCalls, 0); assert.equal(h.controller.pending, null); assert.match(h.frame.message, /选择发生变化/);
});

test('manual continuation works with auto off and starts the selected video once', async t => {
  const h = makeHarness(t); h.controller.configure({ enabled: false }); h.controller.continueToNextVideo();
  assert.deepEqual(h.clicked, ['destination']); assert.equal(h.controller.pending.kind, 'manual');
  const { state } = h.showVideo(); h.controller.tick(); h.advance(500); await flush();
  assert.equal(state.playCalls, 1); assert.equal(h.controller.pending, null); assert.equal(h.controller.enabled, false);
});

test('manual continuation refuses hidden, modal or missing destinations', async t => {
  for (const mode of ['hidden', 'modal', 'last quiz']) await t.test(mode, st => {
    const h = makeHarness(st); h.controller.tick();
    if (mode === 'hidden') h.visibility = 'hidden';
    if (mode === 'modal') h.document.body.insertAdjacentHTML('beforeend', '<div class="el-dialog__wrapper">提示</div>');
    if (mode === 'last quiz') { h.setActive('third-video'); }
    h.controller.continueToNextVideo(); assert.deepEqual(h.clicked, []); assert.equal(h.controller.pending, null);
  });
});

function installContent(h, settings = {}) {
  const { window } = h;
  let time = 0;
  const intervals = [];
  const timeouts = [];
  const writes = [];
  window.Date.now = () => time;
  window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  window.setTimeout = (callback, delay) => { timeouts.push({ callback, due: time + delay }); return timeouts.length; };
  window.chrome = { runtime: {}, storage: { local: {
    get: (_, callback) => callback(settings), set: (value, callback) => { writes.push(value); callback?.(); },
  }, onChanged: { addListener() {} } } };
  window.eval(fs.readFileSync(require.resolve('../core.js'), 'utf8'));
  window.eval(fs.readFileSync(require.resolve('../content.js'), 'utf8'));
  const host = h.document.getElementById('wanfang-auto-next-extension');
  const $ = id => host.shadowRoot.getElementById(id);
  async function advance(ms = 500) {
    time += ms;
    for (const timer of timeouts.splice(0)) { if (timer.due <= time) timer.callback(); else timeouts.push(timer); }
    for (const callback of intervals) callback();
    await flush();
  }
  return { $, host, advance, writes };
}

test('content continue button is available with auto off and handles navigation/play', async t => {
  const h = makeHarness(t, { done: true }); const ui = installContent(h, { wanfangEnabled: false });
  assert.equal(ui.$('continue').hidden, false); assert.equal(ui.$('actions').hidden, false);
  assert.equal(ui.$('continue').title, '播放：2.3 下个视频');
  ui.$('continue').click(); assert.deepEqual(h.clicked, ['destination']); assert.equal(ui.$('continue').hidden, true);
  const { state } = h.showVideo(); await ui.advance(); await ui.advance();
  assert.equal(state.playCalls, 1); assert.equal(ui.$('toggle').getAttribute('aria-pressed'), 'false');
});

test('content detects success DOM change, exposes cancellation and never auto-submits', async t => {
  const h = makeHarness(t); let submissions = 0; h.document.querySelector('.submit').addEventListener('click', () => submissions++);
  const ui = installContent(h); await ui.advance(10000); assert.equal(submissions, 0); assert.deepEqual(h.clicked, []);
  h.complete(); await ui.advance(); assert.equal(ui.$('cancel').hidden, false); assert.match(ui.$('status').textContent, /测验已提交，5 秒/);
  ui.$('cancel').click(); await ui.advance(10000); assert.deepEqual(h.clicked, []); assert.equal(ui.$('continue').hidden, false);
});
