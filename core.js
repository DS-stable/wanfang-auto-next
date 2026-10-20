/* Runs in the extension's isolated world. No page internals or course APIs. */
(function (root) {
  "use strict";

  const SELECTORS = Object.freeze({
    course: "#courseLearnBox",
    title: "#courseLearnBox #rightBox .topBox .title_box h1",
    video: "#courseLearnBox #rightBox .in-player-panel video",
    next: "#courseLearnBox #rightBox .progress-count .right > span.next[title]",
    last: "#courseLearnBox #rightBox .progress-count .right > span.next-no-active",
    nonVideo: "#courseLearnBox #rightBox .quiz, #courseLearnBox #rightBox #blank",
    quiz: "#courseLearnBox #rightBox .quiz",
    directory: "#courseLearnBox #leftBox .tree-menu li.tree_item",
  });
  const SDK_ENDED_EVENT = "wanfang-auto-next-sdk-ended-v1";

  function sourceOf(video) {
    return video ? video.currentSrc || video.getAttribute("src") ||
      video.querySelector("source[src]")?.getAttribute("src") || "" : "";
  }

  function visible(element, view) {
    if (!element || !element.isConnected || element.hidden) return false;
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      element.getClientRects().length > 0;
  }

  function readDirectory(doc) {
    // Work in DOM order, including folded chapters. Only leaf rows navigate.
    const entries = [...doc.querySelectorAll(SELECTORS.directory)].flatMap((li, position) => {
      const node = li.querySelector(":scope > .firstSpan");
      if (!node || li.querySelector(":scope > ul.childUl li.tree_item")) return [];
      const name = node.querySelector(":scope > .tree-name")?.textContent.trim() || "";
      const code = node.querySelector(":scope > .index, :scope > .course-index")?.textContent.trim() || "";
      // In the site's renderer documents have a leading icon; learned-video
      // checkmarks sit on the right. Quiz leaves have no name or numeric span.
      const leadingIcon = [...node.querySelectorAll(":scope > img")].some(img =>
        (img.style.left && img.style.left !== "auto") ||
        /(?:pdf|document|word|ppt)/i.test(img.getAttribute("src") || ""));
      const kind = !name || !code ? "quiz" : leadingIcon ? "document" : "video";
      return [{ node, key: code || `item:${position}`, kind,
        title: name ? `${code} ${name}`.trim() : "随堂测验" }];
    });
    const activeIndex = entries.findIndex(entry => entry.node.classList.contains("active"));
    if (activeIndex < 0) return { activeKey: "", next: null };
    const next = entries.slice(activeIndex + 1).find(entry => entry.kind === "video" &&
      entry.node.getAttribute("aria-disabled") !== "true" &&
      !entry.node.classList.contains("is-disabled")) || null;
    return { activeKey: entries[activeIndex].key, next };
  }

  function revealDirectoryTarget(node) {
    const ancestors = [];
    for (let parent = node.parentElement?.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches("li.tree_item")) ancestors.unshift(parent);
    }
    for (const li of ancestors) {
      const children = li.querySelector(":scope > ul.childUl");
      if (children && node.ownerDocument.defaultView.getComputedStyle(children).display === "none") {
        li.querySelector(":scope > .firstSpan")?.click();
      }
    }
  }

  function readSnapshot(doc, location) {
    const supported = location.hostname === "cx.wanfangdata.com.cn" &&
      /^\/e-training\/quality\/courselearn\/?$/.test(location.pathname);
    const title = doc.querySelector(SELECTORS.title)?.textContent.trim() || "";
    const video = doc.querySelector(SELECTORS.video);
    const directory = readDirectory(doc);
    const quiz = doc.querySelector(SELECTORS.quiz);
    const warningId = quiz?.querySelector('[id^="quiz_warning_"]')?.id || "";
    const quizCode = warningId.replace(/^quiz_warning_/, "").replace(/\.\d+$/, "");
    const quizDone = !!quiz && !!quiz.querySelector(".answer") &&
      [...quiz.querySelectorAll("button.submit")].some(button =>
        button.textContent.trim() === "重新测验" && visible(button, doc.defaultView));
    const candidate = doc.querySelector(SELECTORS.next);
    const next = visible(candidate, doc.defaultView) &&
      candidate.getAttribute("aria-disabled") !== "true" &&
      !candidate.classList.contains("is-disabled") ? candidate : null;
    // Element UI dialogs cover the player and may require a user decision.
    const modal = [...doc.querySelectorAll(
      ".el-message-box__wrapper, .el-dialog__wrapper, [role='dialog'][aria-modal='true']"
    )].some(node => visible(node, doc.defaultView));
    return {
      supported,
      route: location.href,
      // Quiz headings repeat across chapters; warning IDs include listResourceCode.
      key: quiz ? `quiz:${quizCode || directory.activeKey || title}` : title,
      title,
      video,
      source: sourceOf(video),
      next,
      nextTitle: next?.getAttribute("title")?.trim() || "下一节",
      last: visible(doc.querySelector(SELECTORS.last), doc.defaultView),
      nonVideo: !!doc.querySelector(SELECTORS.nonVideo),
      quiz: !!quiz,
      quizDone,
      directoryActiveKey: directory.activeKey,
      directoryNext: directory.next,
      hidden: doc.visibilityState === "hidden",
      modal,
    };
  }

  function sameLesson(a, b) {
    return a.route === b.route && a.key === b.key &&
      a.video === b.video && a.source === b.source;
  }

  function matchesNextTitle(title, nextTitle) {
    const normalize = value => String(value || "").replace(/\s+/gu, " ").trim();
    const actual = normalize(title);
    const expected = normalize(nextTitle);
    return !!expected && (actual === expected || actual.endsWith(` ${expected}`));
  }

  function finished(video, evidence = "native") {
    if (!video || video.seeking || video.error || !Number.isFinite(video.duration) ||
        video.duration <= 0 || !Number.isFinite(video.currentTime) ||
        video.currentTime < video.duration - 0.75) return false;
    return video.ended || (evidence === "sdk" && video.paused);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "--:--";
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  class Controller {
    constructor({ read, render, now = () => Date.now() }) {
      this.read = read;
      this.render = render;
      this.now = now;
      this.enabled = true;
      this.delay = 5;
      this.resumeDelay = 0;
      this.resumePending = null;
      this.resumeObserved = null;
      this.resumeBlocked = null;
      this.pending = null;
      this.handled = new WeakMap();
      this.notice = null;
      this.playToken = 0;
      this.retry = false;
      this.quizState = null;
      this.handledQuizzes = new Set();
    }

    configure({ enabled, delay, resumeDelay } = {}) {
      if (typeof enabled === "boolean") this.enabled = enabled;
      if ([3, 5, 10].includes(Number(delay))) {
        const changed = this.delay !== Number(delay);
        this.delay = Number(delay);
        if (changed && this.pending?.phase === "countdown") {
          this.pending.deadline = this.now() + this.delay * 1000;
        }
      }
      if (!this.enabled && this.pending?.kind !== "manual") this.stop();
      if (resumeDelay !== undefined && [0, 5].includes(Number(resumeDelay)) &&
          this.resumeDelay !== Number(resumeDelay)) {
        this.resumeDelay = Number(resumeDelay);
        this.resumePending = null;
        this.resumeBlocked = null;
        if (!this.resumeDelay && this.pending?.resume) this.stop();
        if (this.resumeDelay) this.scheduleResume(this.read());
      }
      this.tick();
    }

    stop() {
      this.pending = null;
      this.playToken += 1;
      this.retry = false;
      this.notice = null;
    }

    show(snapshot, message, options = {}) {
      this.render({
        supported: snapshot.supported,
        enabled: this.enabled,
        delay: this.delay,
        title: snapshot.title,
        nextTitle: snapshot.nextTitle,
        message,
        countdown: this.pending?.phase === "countdown",
        retry: this.retry,
        canContinue: snapshot.supported && !!snapshot.directoryNext &&
          (!this.pending || this.pending.phase === "countdown"),
        continueLabel: snapshot.nonVideo ? "继续下一视频" : "下一视频",
        continueTitle: snapshot.directoryNext?.title || "",
        resumeDelay: this.resumeDelay,
        resumeCountdown: !!this.resumePending,
        canResume: snapshot.supported && !!snapshot.video && !snapshot.nonVideo,
        resumeMessage: this.resumePending ?
          `视频已暂停，${Math.max(0, Math.ceil((this.resumePending.deadline - this.now()) / 1000))} 秒后继续播放。` :
          this.resumeDelay ? (sameLesson(snapshot, this.resumeBlocked || {}) ? this.resumeBlocked.message :
            "已开启：每次暂停后等 5 秒续播。") : "∞：保持原状，不自动恢复播放。",
        ...options,
      });
    }

    inform(snapshot, message, retry = false) {
      this.pending = null;
      this.playToken += 1;
      this.retry = retry;
      this.notice = { route: snapshot.route, key: snapshot.key, video: snapshot.video,
        source: snapshot.source, message };
      this.show(snapshot, message);
    }

    cancel(message = "已取消本次切换，可手动选择下一节。") {
      this.inform(this.read(), message);
    }

    onPlaying(video) {
      const snapshot = this.read();
      if (video !== snapshot.video || video.ended) return;
      this.resumePending = null;
      this.resumeBlocked = null;
      this.resumeObserved = { ...snapshot, paused: false };
      // A real replay may finish again; duplicate ended events may not advance twice.
      this.handled.delete(video);
      if (this.pending?.phase === "starting" && sameLesson(snapshot, this.pending.playSnapshot)) {
        this.pending = null;
        this.playToken += 1;
      }
      if (this.pending?.phase === "countdown") this.stop();
      this.notice = null;
      this.retry = false;
      this.tick();
    }

    onSeeking(video) {
      if (this.resumePending?.origin.video === video) this.cancelResume("播放位置发生变化，已取消本次续播。");
      if (this.pending?.phase === "countdown" && this.pending.origin.video === video) {
        this.cancel("播放位置发生变化，已取消切换。");
      }
    }

    onEnded(video, evidence = "native") {
      const snapshot = this.read();
      if (snapshot.video === video) this.resumePending = null;
      if (snapshot.video === video && this.pending?.resume && finished(video, evidence)) this.stop();
      if (!snapshot.supported || !this.enabled || snapshot.video !== video ||
          !finished(video, evidence) || !snapshot.key ||
          !snapshot.source || this.pending) return;
      const mark = `${snapshot.route}\n${snapshot.key}\n${snapshot.source}`;
      if (this.handled.get(video) === mark) return;
      this.handled.set(video, mark);
      this.retry = false;
      this.notice = null;
      if (snapshot.hidden) return this.inform(snapshot, "视频已结束，请在前台手动继续。");
      if (snapshot.modal) return this.inform(snapshot, "请先处理页面上的提示，再手动继续。");
      if (snapshot.last) return this.inform(snapshot, "已到最后一节，自动连播结束。");
      if (!snapshot.next) return this.inform(snapshot, "未找到可用的下一节按钮，请手动继续。");
      this.pending = {
        phase: "countdown", origin: snapshot,
        completion: evidence, completedTime: video.currentTime,
        target: snapshot.next, nextTitle: snapshot.nextTitle,
        deadline: this.now() + this.delay * 1000,
      };
      this.tick();
    }

    observeQuiz(snapshot) {
      if (!snapshot.quiz) {
        this.quizState = null;
        return false;
      }
      const id = `${snapshot.route}\n${snapshot.key}`;
      const previous = this.quizState;
      this.quizState = { id, done: snapshot.quizDone };
      if (!snapshot.quizDone) this.handledQuizzes.delete(id);
      return previous?.id === id && !previous.done && snapshot.quizDone &&
        !this.handledQuizzes.has(id);
    }

    scheduleQuiz(snapshot) {
      this.handledQuizzes.add(`${snapshot.route}\n${snapshot.key}`);
      if (snapshot.hidden) return this.inform(snapshot, "测验已提交，请回到前台点击“继续下一视频”。");
      if (snapshot.modal) return this.inform(snapshot, "测验已提交，请处理页面提示后继续。");
      if (!snapshot.directoryNext) return this.inform(snapshot, "测验已提交，目录中没有找到后续视频。");
      this.notice = null;
      this.retry = false;
      this.pending = {
        phase: "countdown", kind: "quiz", origin: snapshot,
        target: snapshot.directoryNext.node,
        destinationKey: snapshot.directoryNext.key,
        nextTitle: snapshot.directoryNext.title,
        deadline: this.now() + this.delay * 1000,
      };
      this.tick();
    }

    beginSwitch(snapshot, pending) {
      pending.phase = "switching";
      pending.deadline = this.now() + 25000;
      this.pending = pending;
      this.notice = null;
      this.retry = false;
      this.show(snapshot, "正在切换下一节…");
      try {
        if (pending.destinationKey) revealDirectoryTarget(pending.target);
        pending.target.click();
      } catch (_) {
        this.inform(snapshot, "切换失败，请从网站左侧目录选择下一节。");
      }
    }

    continueToNextVideo() {
      const snapshot = this.read();
      if (!snapshot.supported || !snapshot.directoryNext ||
          (this.pending && this.pending.phase !== "countdown")) return;
      if (snapshot.hidden || snapshot.modal) return this.inform(snapshot, "请回到课程页并处理提示后继续。");
      this.resumePending = null;
      this.stop();
      this.beginSwitch(snapshot, {
        kind: "manual", origin: snapshot, target: snapshot.directoryNext.node,
        destinationKey: snapshot.directoryNext.key, nextTitle: snapshot.directoryNext.title,
      });
    }

    canScheduleResume(snapshot) {
      const video = snapshot.video;
      return snapshot.supported && !!video && !!snapshot.key && !!snapshot.source &&
        !snapshot.nonVideo && !snapshot.hidden && !snapshot.modal && video.paused &&
        !video.ended && !video.seeking && !video.error && Number.isFinite(video.currentTime) &&
        !(Number.isFinite(video.duration) && video.currentTime >= video.duration - 0.75);
    }

    scheduleResume(snapshot) {
      if (!this.resumeDelay || this.pending || this.resumePending ||
          !this.canScheduleResume(snapshot) || sameLesson(snapshot, this.resumeBlocked || {})) return;
      this.resumePending = { origin: snapshot, deadline: this.now() + this.resumeDelay * 1000 };
    }

    onPaused(video) {
      const snapshot = this.read();
      if (snapshot.video !== video) return;
      this.scheduleResume(snapshot);
      this.tick();
    }

    cancelResume(message = "已取消本次续播；下次暂停时仍会计时。") {
      const snapshot = this.read();
      this.resumePending = null;
      this.resumeBlocked = { ...snapshot, message };
      this.tick();
    }

    tickResume(snapshot) {
      const previous = this.resumeObserved;
      this.resumeObserved = { ...snapshot, paused: snapshot.video?.paused };
      if (!snapshot.supported) {
        this.resumePending = null;
        this.resumeObserved = null;
        this.resumeBlocked = null;
        return false;
      }
      const video = snapshot.video;
      if (this.pending?.resume && video && (video.ended || video.seeking ||
          (Number.isFinite(video.duration) && video.currentTime >= video.duration - 0.75))) {
        this.inform(snapshot, "视频状态发生变化，已停止本次定时续播。");
        this.resumeBlocked = { ...snapshot, message: "本次定时续播已停止，请手动播放。" };
      }
      if (video && !video.paused && !video.seeking && !video.ended && !video.error) this.resumeBlocked = null;
      if (previous && sameLesson(snapshot, previous) && previous.paused === false && snapshot.video?.paused) {
        this.scheduleResume(snapshot);
      }
      const timer = this.resumePending;
      if (!timer) return false;
      if (!this.resumeDelay || this.pending || !sameLesson(snapshot, timer.origin) ||
          !this.canScheduleResume(snapshot)) {
        this.resumePending = null;
        if (sameLesson(snapshot, timer.origin) && snapshot.video?.paused) {
          this.resumeBlocked = { ...snapshot, message: "本次续播已取消；请回到课程页，处理提示后手动播放。" };
        }
        return false;
      }
      if (this.now() < timer.deadline) return false;
      this.resumePending = null;
      // One attempt per pause episode. A rejected play must not re-arm forever.
      this.resumeBlocked = { ...snapshot, message: "已尝试定时续播；播放失败时请点击“播放当前节”。" };
      this.attemptPlay(snapshot, { kind: "manual", resume: true, origin: snapshot });
      return true;
    }

    tick() {
      const snapshot = this.read();
      const quizCompletedNow = this.observeQuiz(snapshot);
      if (this.tickResume(snapshot)) return;
      if (!snapshot.supported) {
        this.stop();
        this.show(snapshot, "");
        return;
      }
      // A direct click on "continue" works even when automatic advancement is off.
      if (!this.enabled && this.pending?.kind !== "manual") {
        this.show(snapshot, "自动连播已关闭。");
        return;
      }
      const pending = this.pending;
      if (!pending && quizCompletedNow) return this.scheduleQuiz(snapshot);
      if (pending) {
        if (snapshot.route !== pending.origin.route) {
          this.stop();
          return this.tick();
        }
        if (snapshot.hidden) return this.cancel("已取消自动切换，请保持课程页在前台。");
        if (snapshot.modal) return this.cancel("请先处理页面上的提示，再手动继续。");
        if (pending.phase === "countdown") {
          if (!sameLesson(snapshot, pending.origin)) {
            this.stop();
            return this.tick();
          }
          if (pending.kind === "quiz" && !snapshot.quizDone) {
            return this.cancel("测验已重新开始，已取消切换。");
          }
          if (pending.kind !== "quiz" &&
              (!finished(snapshot.video, pending.completion) ||
               snapshot.video.currentTime < pending.completedTime - 0.1)) {
            return this.cancel("视频已重新播放或播放位置发生变化，已取消切换。");
          }
          const targetChanged = pending.kind === "quiz" ?
            snapshot.directoryNext?.node !== pending.target || snapshot.directoryNext?.key !== pending.destinationKey ||
              snapshot.directoryNext?.title !== pending.nextTitle :
            snapshot.next !== pending.target || snapshot.nextTitle !== pending.nextTitle;
          if (targetChanged) {
            return this.cancel("下一节按钮发生变化，请手动继续。");
          }
          const remaining = Math.ceil((pending.deadline - this.now()) / 1000);
          if (remaining > 0) {
            return this.show(snapshot, `${pending.kind === "quiz" ? "测验已提交，" : ""}${remaining} 秒后切换：${pending.nextTitle}`);
          }
          // Set the state before clicking: a synchronous DOM update cannot click twice.
          return this.beginSwitch(snapshot, pending);
        }
        if (this.now() >= pending.deadline) {
          return this.inform(snapshot, pending.phase === "starting" ?
            "播放启动超时，请检查页面后点击“播放当前节”。" :
            "下一节载入超时，请检查页面后手动播放。", !!snapshot.video);
        }
        if (pending.phase === "starting") {
          if (!sameLesson(snapshot, pending.playSnapshot)) {
            this.stop();
            return this.tick();
          }
          const video = snapshot.video;
          if (video.error) return this.inform(snapshot, "视频载入出错，请点击“播放当前节”重试。", true);
          if (!video.paused && !video.seeking && video.readyState >= 2) {
            const probe = pending.progressProbe;
            if (probe) {
              const elapsed = (this.now() - probe.at) / 1000;
              const delta = video.currentTime - probe.position;
              const maxDelta = Math.max(2, elapsed * Math.max(1, video.playbackRate || 1) * 2 + 1);
              if (elapsed >= 0.2 && delta >= 0.2 && delta <= maxDelta) {
                this.pending = null;
                this.playToken += 1;
                return this.tick();
              }
              if (delta < 0 || delta > maxDelta) pending.progressProbe = null;
            }
            if (!pending.progressProbe) pending.progressProbe = { at: this.now(), position: video.currentTime };
          } else pending.progressProbe = null;
          // Aliplayer may pause again while restoring the saved position. Retry
          // the same media a few times; never click the next-lesson control again.
          if (video.paused && !video.seeking && pending.attempts < 3 &&
              this.now() - pending.lastAttempt >= 3000) return this.attemptPlay(snapshot, pending);
          this.show(snapshot, "正在启动播放，等待播放器确认…");
          return;
        }
        if (snapshot.key && snapshot.key !== pending.origin.key) {
          if (snapshot.nonVideo && !snapshot.video) {
            return this.inform(snapshot, "下一项是测验或文档，请手动完成后继续。");
          }
          if (!matchesNextTitle(snapshot.title, pending.nextTitle)) {
            return this.inform(snapshot, "课程选择发生变化，已取消自动播放。");
          }
          if (pending.destinationKey && snapshot.directoryActiveKey !== pending.destinationKey) {
            return this.inform(snapshot, "课程选择发生变化，已取消自动播放。");
          }
          if (snapshot.video && snapshot.source &&
              (snapshot.video !== pending.origin.video || snapshot.source !== pending.origin.source)) {
            if (pending.phase === "switching") {
              // Let Aliplayer finish its own initialization and resume-position callback.
              if (pending.candidate !== snapshot.video || pending.source !== snapshot.source) {
                pending.candidate = snapshot.video;
                pending.source = snapshot.source;
                pending.readySince = this.now();
              }
              // play() can be needed to start fetching data. Waiting for a
              // decoded frame here can deadlock players with preload disabled.
              if (this.now() - pending.readySince >= 500) {
                return this.attemptPlay(snapshot, pending);
              }
            }
          }
        }
        this.show(snapshot, pending.phase === "starting" ? "正在启动播放…" : "等待下一节播放器载入…");
        return;
      }
      if (this.notice && !sameLesson(snapshot, this.notice)) {
        this.notice = null;
        this.retry = false;
      }
      if (this.notice) return this.show(snapshot, this.notice.message);
      if (!snapshot.video) {
        if (snapshot.quiz) {
          if (!snapshot.directoryNext) return this.show(snapshot, "当前是随堂测验，请完成并提交；未找到后续视频。");
          return this.show(snapshot, snapshot.quizDone ? "测验已提交，可点击“继续下一视频”。" :
            "请完成测验并提交，提交成功后会自动继续下一视频。");
        }
        return this.show(snapshot, snapshot.nonVideo ? "当前是测验或文档，完成后请手动选择视频。" :
          "等待播放器，请确认已登录并进入视频课件。");
      }
      if (snapshot.hidden) return this.show(snapshot, "请保持课程页在前台，网站会暂停后台视频。");
      const pausedMessage = snapshot.video.currentTime > 0.5 ?
        `当前节已暂停（${formatTime(snapshot.video.currentTime)} / ${formatTime(snapshot.video.duration)}），继续播放后才会自动切换。` :
        "请先手动播放当前节，结束后会自动切换。";
      this.show(snapshot, snapshot.video.paused ? pausedMessage : "正在播放，结束后会自动切换下一节。");
    }

    attemptPlay(snapshot, pending = null) {
      if (!snapshot.video || snapshot.hidden || snapshot.modal) return;
      this.resumePending = null;
      const token = ++this.playToken;
      if (!pending) pending = { kind: "manual", origin: snapshot };
      pending.phase = "starting";
      pending.playSnapshot = snapshot;
      pending.startDeadline ??= this.now() + 60000;
      pending.deadline = pending.startDeadline;
      pending.lastAttempt = this.now();
      pending.attempts = (pending.attempts || 0) + 1;
      pending.progressProbe = null;
      this.pending = pending;
      this.retry = false;
      this.show(snapshot, "正在启动播放…");
      let result;
      try {
        // In a retry-button click this executes synchronously, preserving user activation.
        result = snapshot.video.play();
      } catch (error) {
        result = Promise.reject(error);
      }
      // Some SDK wrappers return undefined, which is not playback confirmation.
      // For those, keep supervising until playing or actual progress is observed.
      if (!result || typeof result.then !== "function") return;
      Promise.resolve(result).then(() => {
        if (token !== this.playToken) return;
        const current = this.read();
        if (!sameLesson(current, snapshot)) {
          this.stop();
          return this.tick();
        }
        if (!current.video.paused && current.video.readyState >= 2) {
          this.pending = null;
          this.notice = null;
          this.retry = false;
        }
        this.tick();
      }).catch(error => {
        if (token !== this.playToken) return;
        const current = this.read();
        if (!sameLesson(current, snapshot)) {
          this.stop();
          return this.tick();
        }
        if (error?.name === "AbortError") {
          this.show(current, "播放器正在恢复进度，稍后会重试播放…");
          return;
        }
        const message = error?.name === "NotAllowedError" ?
          "浏览器阻止了自动播放，请点击“播放当前节”。" :
          "播放未能启动，请点击“播放当前节”或网站播放按钮。";
        this.inform(current, message, true);
      });
    }

    playCurrent() {
      const snapshot = this.read();
      if (snapshot.supported) this.attemptPlay(snapshot);
    }
  }

  const api = { SELECTORS, SDK_ENDED_EVENT, readDirectory, readSnapshot, sameLesson, matchesNextTitle, Controller };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WanfangAutoNext = api;
})(globalThis);
