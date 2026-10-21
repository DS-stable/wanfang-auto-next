(function () {
  "use strict";
  if (window.top !== window || document.getElementById("wanfang-auto-next-extension")) return;
  const { readSnapshot, Controller, SDK_ENDED_EVENT } = globalThis.WanfangAutoNext;
  const host = document.createElement("div");
  host.id = "wanfang-auto-next-extension";
  host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;display:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all:initial; color-scheme:light; }
      * { box-sizing:border-box; }
      .panel { width:310px; max-width:calc(100vw - 36px); padding:16px; background:#fff;
        border:1px solid #d9e3f2; border-radius:14px; box-shadow:0 8px 36px #132d5826;
        font:13px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif; color:#22314a; }
      header { display:flex; align-items:center; gap:8px; }
      .dot { width:9px; height:9px; flex:none; border-radius:50%; background:#2864d7; }
      .off .dot { background:#8491a5; }
      h2 { font-size:14px; line-height:1.4; margin:0; font-weight:650; flex:1; }
      .version { font-size:10px; font-weight:400; color:#78869a; margin-left:4px; }
      button, select { font:inherit; cursor:pointer; }
      button { border:1px solid #c8d6eb; border-radius:7px; background:#fff;
        color:#335d99; padding:5px 10px; line-height:1.4; }
      button:hover { background:#eef4ff; }
      button:focus-visible, select:focus-visible { outline:2px solid #2965d7; outline-offset:2px; }
      #collapse { border:0; color:#6c7b90; padding:2px 3px; font-size:12px; }
      #status { min-height:42px; margin:12px 0; line-height:1.65; overflow-wrap:anywhere; }
      #lesson { color:#78869a; font-size:12px; overflow:hidden; text-overflow:ellipsis;
        white-space:nowrap; margin-top:7px; }
      .controls { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      label { font-size:12px; color:#63738a; }
      select { border:1px solid #d6dfeb; border-radius:5px; padding:3px; background:#fff; color:#334e73; }
      #toggle[aria-pressed="true"], #resume-toggle[aria-pressed="true"], #play { background:#2864d7; color:#fff; border-color:#2864d7; }
      #toggle[aria-pressed="true"]:hover, #resume-toggle[aria-pressed="true"]:hover, #play:hover { background:#1c51b6; }
      #resume-controls { margin-top:12px; padding-top:12px; border-top:1px solid #e7edf5; }
      #resume-controls .controls { justify-content:flex-start; flex-wrap:wrap; }
      #resume-status { margin:7px 0 0; color:#63738a; font-size:12px; }
      #actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
      [hidden] { display:none !important; }
      #compact { display:flex; align-items:center; gap:7px; padding:9px 13px; background:#fff;
        border:1px solid #d9e3f2; border-radius:24px; box-shadow:0 4px 22px #132d5820;
        font:13px system-ui,-apple-system,"Microsoft YaHei",sans-serif; color:#335d99; }
      @media(prefers-reduced-motion:no-preference) { button { transition:background .12s; } }
    </style>
    <section class="panel" aria-label="万方课程自动连播">
      <header><span class="dot" aria-hidden="true"></span><h2>万方 · 自动连播<span class="version">1.3.1</span></h2>
        <button id="collapse" type="button" aria-label="收起自动连播面板">收起</button></header>
      <div id="lesson"></div>
      <p id="status" role="status" aria-live="polite"></p>
      <div class="controls">
        <button id="toggle" type="button" aria-pressed="true">已开启 · 点击关闭</button>
        <label>切换等待 <select id="delay" aria-label="视频结束后的等待时间">
          <option value="3">3 秒</option><option value="5" selected>5 秒</option><option value="10">10 秒</option>
        </select></label>
      </div>
      <div id="actions" hidden>
        <button id="cancel" type="button" hidden>取消本次切换</button>
        <button id="play" type="button" hidden>播放当前节</button>
        <button id="continue" type="button" hidden>继续下一视频</button>
      </div>
      <div id="resume-controls" hidden>
        <div class="controls">
          <button id="resume-toggle" type="button" aria-pressed="false"
            title="点击切换：暂停 5 秒后继续播放 / ∞ 保持原状">定时续播：∞</button>
          <button id="resume-cancel" type="button" hidden>取消本次续播</button>
        </div>
        <p id="resume-status" role="status" aria-live="polite"></p>
      </div>
    </section>
    <button id="compact" type="button" aria-label="展开自动连播面板" hidden>
      <span class="dot" aria-hidden="true"></span><span id="compact-text">自动连播已开启</span>
    </button>`;
  (document.body || document.documentElement).appendChild(host);
  const $ = id => shadow.getElementById(id);
  const panel = shadow.querySelector(".panel");
  let minimized = false;
  let lastView;

  function render(view) {
    lastView = view;
    host.style.display = view.supported ? "block" : "none";
    panel.hidden = minimized;
    $("compact").hidden = !minimized;
    panel.classList.toggle("off", !view.enabled);
    $("status").textContent = view.message;
    $("lesson").textContent = view.title || "万方科研诚信培训系统";
    $("lesson").title = view.title || "";
    $("toggle").setAttribute("aria-pressed", String(view.enabled));
    $("toggle").textContent = view.enabled ? "已开启 · 点击关闭" : "已关闭 · 点击开启";
    $("delay").value = String(view.delay);
    $("cancel").hidden = !view.countdown;
    $("play").hidden = !view.retry;
    $("continue").hidden = !view.canContinue;
    $("continue").textContent = view.continueLabel || "继续下一视频";
    $("continue").title = view.continueTitle ? `播放：${view.continueTitle}` : "";
    $("actions").hidden = !view.countdown && !view.retry && !view.canContinue;
    $("resume-controls").hidden = !view.canResume;
    $("resume-toggle").setAttribute("aria-pressed", String(view.resumeDelay === 5));
    $("resume-toggle").textContent = view.resumeDelay === 5 ? "定时续播：5 秒" : "定时续播：∞";
    $("resume-cancel").hidden = !view.resumeCountdown;
    $("resume-status").textContent = view.resumeMessage;
    $("compact-text").textContent = view.resumeCountdown ? view.resumeMessage : view.countdown ? view.message :
      view.retry ? "点击展开并播放" : view.canContinue ? "自动连播 · 点击展开" :
      view.enabled ? "自动连播已开启" : "自动连播已关闭";
  }

  const controller = new Controller({ read: () => readSnapshot(document, location), render });
  // Wait for extension preferences before accepting media events.
  let initialized = false;
  const bound = new WeakSet();
  function refresh() {
    if (!initialized) return;
    const { video } = readSnapshot(document, location);
    if (video && !bound.has(video)) {
      bound.add(video);
      video.addEventListener("ended", () => controller.onEnded(video));
      video.addEventListener(SDK_ENDED_EVENT, () => controller.onEnded(video, "sdk"));
      video.addEventListener("playing", () => controller.onPlaying(video));
      video.addEventListener("seeking", () => controller.onSeeking(video));
      video.addEventListener("loadedmetadata", queueRefresh);
      video.addEventListener("pause", () => controller.onPaused(video));
    }
    controller.tick();
  }

  let refreshTimer = null;
  function queueRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 120);
  }

  function save() {
    try {
      chrome.storage.local.set({ wanfangEnabled: controller.enabled, wanfangDelay: controller.delay,
        wanfangResumeDelay: controller.resumeDelay }, () => {
        // A reloaded unpacked extension can invalidate the old page context.
        void chrome.runtime.lastError;
      });
    } catch (_) { /* Current-page controls still work until the next refresh. */ }
  }

  $("toggle").addEventListener("click", () => {
    controller.configure({ enabled: !controller.enabled });
    save();
  });
  $("delay").addEventListener("change", event => {
    controller.configure({ delay: Number(event.target.value) });
    save();
  });
  $("cancel").addEventListener("click", () => controller.cancel());
  $("play").addEventListener("click", () => controller.playCurrent());
  $("continue").addEventListener("click", () => controller.continueToNextVideo());
  $("resume-toggle").addEventListener("click", () => {
    controller.configure({ resumeDelay: controller.resumeDelay === 5 ? 0 : 5 });
    save();
  });
  $("resume-cancel").addEventListener("click", () => controller.cancelResume());
  $("collapse").addEventListener("click", () => { minimized = true; render(lastView); });
  $("compact").addEventListener("click", () => { minimized = false; render(lastView); });

  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== host && !host.contains(record.target))) queueRefresh();
  });
  observer.observe(document.body || document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["src", "class", "style", "title", "aria-disabled"],
  });
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener("hashchange", refresh);
  // Also detects SPA pushState routes, which don't emit popstate.
  setInterval(refresh, 500);

  try {
    chrome.storage.local.get(["wanfangEnabled", "wanfangDelay", "wanfangResumeDelay"], settings => {
      void chrome.runtime.lastError;
      initialized = true;
      controller.configure({ enabled: settings?.wanfangEnabled, delay: settings?.wanfangDelay,
        resumeDelay: settings?.wanfangResumeDelay });
      refresh();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      controller.configure({ enabled: changes.wanfangEnabled?.newValue, delay: changes.wanfangDelay?.newValue,
        resumeDelay: changes.wanfangResumeDelay ? changes.wanfangResumeDelay.newValue ?? 0 : undefined });
    });
  } catch (_) {
    initialized = true;
    refresh();
  }
})();
