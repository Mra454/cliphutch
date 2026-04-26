chrome.runtime.onInstalled.addListener((details) => {
  console.log("[video-archive] background installed:", details.reason);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("firstrun.html") });
  }
});

console.log("[video-archive] service worker booted");
