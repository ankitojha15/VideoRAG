function getVideoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&\/\?#]+)/);
    if (m) return m[1];
    return null;
  } catch { return null; }
}

let lastVideoId = getVideoIdFromUrl(location.href);
let lastUrl = location.href;

function notifyIfChanged() {
  const newUrl = location.href;
  if (newUrl === lastUrl) return;
  lastUrl = newUrl;
  const newId = getVideoIdFromUrl(newUrl);
  if (newId && newId !== lastVideoId) {
    lastVideoId = newId;
    chrome.runtime.sendMessage({ type: "VIDEO_CHANGED", videoId: newId });
  } else if (!newId) {
    lastVideoId = null;
  }
}

window.addEventListener("yt-navigate-finish", notifyIfChanged);

const origPushState = history.pushState;
history.pushState = function(...args) {
  origPushState.apply(this, args);
  setTimeout(notifyIfChanged, 300);
};
const origReplaceState = history.replaceState;
history.replaceState = function(...args) {
  origReplaceState.apply(this, args);
  setTimeout(notifyIfChanged, 300);
};
window.addEventListener("popstate", () => setTimeout(notifyIfChanged, 300));

setInterval(notifyIfChanged, 1000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_VIDEO_ID_CONTENT") {
    sendResponse({ videoId: getVideoIdFromUrl(location.href), url: location.href });
  }
});
