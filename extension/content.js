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
  if (msg.type === "GET_CAPTION_TRACKS") {
    // Browser-side caption fallback: the page already loaded fine on the
    // user's (residential) IP, so captionTracks are available here even when
    // YouTube blocks the backend server's cloud IP.
    sendResponse({ tracks: extractCaptionTracks() });
  }
});

// ---- Browser-side caption track extraction ----
// Reads captionTracks from the already-loaded YouTube page HTML.
// Runs in the isolated content-script world, so no page-JS access is needed.
function extractCaptionTracks() {
  try {
    const html = document.documentElement.innerHTML;
    const key = '"captionTracks":';
    const idx = html.indexOf(key);
    if (idx === -1) return [];
    let i = idx + key.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== '[') return [];
    // Balanced-bracket scan (string- and escape-aware) to grab the JSON array.
    let depth = 0, inStr = false, esc = false;
    const start = i;
    for (; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '[') depth++;
        else if (c === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
    }
    if (depth !== 0) return [];
    const arr = JSON.parse(html.slice(start, i + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t) => t && t.baseUrl)
      .map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode || "",
        // kind === 'asr' means auto-generated; missing kind means manual.
        kind: t.kind || "standard",
        name: (t.name && t.name.simpleText) || t.languageCode || "",
      }));
  } catch {
    return [];
  }
}
