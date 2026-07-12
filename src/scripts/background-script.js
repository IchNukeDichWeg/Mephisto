chrome.runtime.onMessage.addListener(function (msg, sender) {
  if ((msg.from === 'content') && (msg.subject === 'showPageAction')) {
    chrome.pageAction.show(sender.tab.id);
  }
});

// no default_popup anymore: the toolbar icon toggles the draggable in-page overlay instead
chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, {toggleOverlay: true}, () => void chrome.runtime.lastError);
});
