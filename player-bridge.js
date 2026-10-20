/* MAIN world: subscribe to the site's Aliplayer API without changing playback. */
(function () {
  "use strict";
  const ENDED_EVENT = "wanfang-auto-next-sdk-ended-v1";
  const VIDEO_SELECTOR = "#courseLearnBox #rightBox .in-player-panel video";
  let binding = null;
  let refreshTimer = null;

  function unbind() {
    if (!binding) return;
    try { binding.player.off("ended", binding.listener); } catch (_) { /* Disposed player. */ }
    binding = null;
  }

  function refresh() {
    const video = document.querySelector(VIDEO_SELECTOR);
    // Aliplayer's H5 createEl stores its instance on the media element.
    const player = video?.player;
    if (binding?.video === video && binding.player === player) return;
    unbind();
    if (!video || !player || player.tag !== video || typeof player.on !== "function" ||
        typeof player.off !== "function") return;
    const listener = () => {
      if (video.isConnected && video.player === player && player.tag === video &&
          document.querySelector(VIDEO_SELECTOR) === video) {
        // No account data, media URL, player internals or commands cross worlds.
        // The isolated script validates the current lesson and media end position.
        video.dispatchEvent(new Event(ENDED_EVENT));
      }
    };
    try {
      player.on("ended", listener);
      binding = { video, player, listener };
    } catch (_) { /* Retry when the site's player has finished initializing. */ }
  }

  function queueRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 80);
  }

  const observer = new MutationObserver(queueRefresh);
  observer.observe(document.body || document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["src"],
  });
  setInterval(refresh, 500);
  refresh();
})();
