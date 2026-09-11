const BACKEND_URL = "https://videorag-7swz.onrender.com";

const els = {
  notYoutube: document.getElementById("notYoutube"),
  processing: document.getElementById("processing"),
  error: document.getElementById("error"),
  errorMsg: document.getElementById("errorMsg"),
  retryBtn: document.getElementById("retryBtn"),
  qaSection: document.getElementById("qaSection"),
  videoIdBadge: document.getElementById("videoIdBadge"),
  questionInput: document.getElementById("questionInput"),
  askBtn: document.getElementById("askBtn"),
  chatHistory: document.getElementById("chatHistory"),
  askingIndicator: document.getElementById("askingIndicator"),
};

let currentVideoId = null;
let isProcessing = false;

function getVideoIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1).split("/")[0] || null;
    }
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&\/\?#]+)/);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

function showOnly(stateEl) {
  for (const el of [els.notYoutube, els.processing, els.error, els.qaSection]) {
    if (el === stateEl) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }
}

function addChat(role, text) {
  const div = document.createElement("div");
  div.className = `chat-item ${role}`;
  div.textContent = text;
  els.chatHistory.appendChild(div);
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadChatHistory(videoId) {
  const key = `chat_${videoId}`;
  const data = await chrome.storage.local.get(key);
  els.chatHistory.innerHTML = "";
  if (data[key] && Array.isArray(data[key])) {
    for (const { role, text } of data[key]) {
      addChat(role, text);
    }
  }
}

async function saveChat(videoId, role, text) {
  const key = `chat_${videoId}`;
  const data = await chrome.storage.local.get(key);
  const arr = data[key] || [];
  arr.push({ role, text });
  await chrome.storage.local.set({ [key]: arr });
}

function setProcessingText(line1, line2) {
  const ps = els.processing.querySelectorAll("p");
  if (ps[0] && line1) ps[0].textContent = line1;
  if (ps[1] && line2) ps[1].textContent = line2;
}

async function markProcessed(videoId) {
  const { processedVideos = [] } = await chrome.storage.local.get("processedVideos");
  if (!processedVideos.includes(videoId)) {
    processedVideos.push(videoId);
    await chrome.storage.local.set({ processedVideos });
  }
  await chrome.storage.local.set({ lastVideoId: videoId });
  await loadChatHistory(videoId);
  showOnly(els.qaSection);
}

// ---- Browser-side caption fallback ----
// YouTube blocks cloud-server IPs (Render), so /process fails with 500 for
// every video. The user's own browser IP is residential (not blocked), so we
// fetch the captions here and send the text to /process_text for RAG.
async function getCaptionTracksFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error("No active tab found");
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_CAPTION_TRACKS" });
  } catch {
    throw new Error("Please reload the YouTube page and retry");
  }
  const tracks = (resp && resp.tracks) || [];
  if (!tracks.length) throw new Error("No captions found on this YouTube page");
  return tracks;
}

function pickBestTrack(tracks) {
  const rank = (t) => {
    const lang = String(t.languageCode || "").toLowerCase();
    const langRank = lang.startsWith("en") ? 0 : lang.startsWith("hi") ? 1 : 2;
    const manualBonus = t.kind === "asr" ? 1 : 0; // prefer manually created captions
    return langRank * 10 + manualBonus;
  };
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0];
}

async function downloadTrackText(track) {
  const sep = track.baseUrl.includes("?") ? "&" : "?";
  const res = await fetch(`${track.baseUrl}${sep}fmt=json3`);
  if (!res.ok) throw new Error("Caption download failed");
  const data = await res.json();
  const parts = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const line = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\n/g, " ")
      .trim();
    if (line && line !== parts[parts.length - 1]) parts.push(line);
  }
  return parts.join(" ");
}

async function processViaBrowser(videoId) {
  const tracks = await getCaptionTracksFromPage();
  const track = pickBestTrack(tracks);
  setProcessingText(
    `Found captions (${track.name || track.languageCode}).`,
    "Downloading + processing..."
  );
  const transcript = await downloadTrackText(track);
  if (!transcript || transcript.length < 20) {
    throw new Error("Caption text came out empty");
  }
  const res = await fetch(`${BACKEND_URL}/process_text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, transcript }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || "Failed to process browser captions");
}

async function processVideo(videoId) {
  if (isProcessing) return;
  isProcessing = true;
  showOnly(els.processing);
  setProcessingText("Processing video...", "Fetching transcript...");
  els.videoIdBadge.textContent = videoId;
  els.videoIdBadge.classList.remove("hidden");

  try {
    const res = await fetch(`${BACKEND_URL}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await markProcessed(videoId);
      return;
    }
    const detail = String(data.detail || data.message || "Failed to process video");
    if (res.status === 500 && detail.toLowerCase().includes("blocking")) {
      // Server IP blocked by YouTube -> browser-side caption fallback.
      setProcessingText("Server IP blocked by YouTube.", "Fetching captions from your browser...");
      await processViaBrowser(videoId);
      await markProcessed(videoId);
      return;
    }
    throw new Error(detail);
  } catch (e) {
    const msg = e.message || "Failed to process video";
    const browserIssue = /no captions?|caption|reload the youtube page/i.test(msg);
    els.errorMsg.textContent = browserIssue
      ? msg
      : msg.includes("No caption")
        ? "No caption available for this video"
        : `Error: ${msg}. Is the backend running at ${BACKEND_URL}?`;
    showOnly(els.error);
  } finally {
    isProcessing = false;
  }
}

async function askQuestion() {
  const q = els.questionInput.value.trim();
  if (!q || !currentVideoId) return;
  if (els.askBtn.disabled) return;

  els.questionInput.value = "";
  addChat("user", q);
  await saveChat(currentVideoId, "user", q);
  els.askBtn.disabled = true;
  els.askingIndicator.classList.remove("hidden");

  try {
    const res = await fetch(`${BACKEND_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: currentVideoId, question: q }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to get answer");
    const answer = data.answer || "No answer returned.";
    addChat("assistant", answer);
    await saveChat(currentVideoId, "assistant", answer);
  } catch (e) {
    addChat("assistant", `Error: ${e.message}`);
  } finally {
    els.askBtn.disabled = false;
    els.askingIndicator.classList.add("hidden");
    els.questionInput.focus();
  }
}

async function init() {
  const tab = await getActiveTab();
  const url = tab?.url || "";
  const videoId = getVideoIdFromUrl(url);

  if (!videoId) {
    currentVideoId = null;
    els.videoIdBadge.classList.add("hidden");
    showOnly(els.notYoutube);
    return;
  }

  currentVideoId = videoId;
  els.videoIdBadge.textContent = videoId;
  els.videoIdBadge.classList.remove("hidden");

  const { lastVideoId, processedVideos = [] } = await chrome.storage.local.get(["lastVideoId", "processedVideos"]);
  const isSameVideo = lastVideoId === videoId && processedVideos.includes(videoId);

  if (isSameVideo) {
    try {
      const r = await fetch(`${BACKEND_URL}/status/${videoId}`);
      const s = await r.json();
      if (s.status === "ready") {
        await loadChatHistory(videoId);
        showOnly(els.qaSection);
        return;
      }
    } catch {}
  }

  // Also check backend cache even if local storage doesn't have it
  try {
    const r = await fetch(`${BACKEND_URL}/status/${videoId}`);
    if (r.ok) {
      const s = await r.json();
      if (s.status === "ready") {
        const data = await chrome.storage.local.get("processedVideos");
        const arr = data.processedVideos || [];
        if (!arr.includes(videoId)) {
          arr.push(videoId);
          await chrome.storage.local.set({ processedVideos: arr, lastVideoId: videoId });
        }
        await loadChatHistory(videoId);
        showOnly(els.qaSection);
        return;
      }
    }
  } catch {}

  // Auto-process without any button click (requirement)
  await processVideo(videoId);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0] || tabs[0].id !== tabId) return;
  const newId = getVideoIdFromUrl(changeInfo.url);
  if (newId && newId !== currentVideoId) {
    currentVideoId = newId;
    els.chatHistory.innerHTML = "";
    await processVideo(newId);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "VIDEO_CHANGED" && msg.videoId && msg.videoId !== currentVideoId) {
    currentVideoId = msg.videoId;
    els.chatHistory.innerHTML = "";
    processVideo(msg.videoId);
  }
});

els.askBtn.addEventListener("click", askQuestion);
els.questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") askQuestion();
});
els.retryBtn.addEventListener("click", () => {
  if (currentVideoId) processVideo(currentVideoId);
});

document.addEventListener("DOMContentLoaded", init);
