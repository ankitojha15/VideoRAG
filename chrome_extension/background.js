chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "VIDEO_CHANGED") {
    chrome.storage.local.set({ lastVideoId: msg.videoId });
  }
  if (msg.type === "GET_VIDEO_ID") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || "";
      sendResponse({ url });
    });
    return true;
  }
});
