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

async function processVideo(videoId) {
  if (isProcessing) return;
  isProcessing = true;
  showOnly(els.processing);
  els.videoIdBadge.textContent = videoId;
  els.videoIdBadge.classList.remove("hidden");

  try {
    const res = await fetch(`${BACKEND_URL}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || data.message || "Failed to process video");
    }
    const { processedVideos = [] } = await chrome.storage.local.get("processedVideos");
    if (!processedVideos.includes(videoId)) {
      processedVideos.push(videoId);
      await chrome.storage.local.set({ processedVideos });
    }
    await chrome.storage.local.set({ lastVideoId: videoId });
    await loadChatHistory(videoId);
    showOnly(els.qaSection);
  } catch (e) {
    const msg = e.message.includes("No caption")
      ? "No caption available for this video"
      : `Error: ${e.message}. Is the backend running at ${BACKEND_URL}?`;
    els.errorMsg.textContent = msg;
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
