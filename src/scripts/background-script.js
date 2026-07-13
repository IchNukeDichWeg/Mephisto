chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if ((msg.from === 'content') && (msg.subject === 'showPageAction')) {
    chrome.pageAction.show(sender.tab.id);
  }
  // the content-script asks for its own tab id so its popup iframe can talk to ONLY this tab
  // (not whatever tab is active) -- otherwise a background tab's popup drives the foreground tab.
  if (msg.getTabId) {
    sendResponse({tabId: sender.tab?.id});
  }
});

// no default_popup anymore: the toolbar icon toggles the draggable in-page overlay instead
chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, {toggleOverlay: true}, () => void chrome.runtime.lastError);
});
