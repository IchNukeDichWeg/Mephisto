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

// UI mode toggle (Settings -> General). Two ways to show the panel:
//   'floating' (default) -- an in-page overlay injected on toolbar click. Richer UX, but the panel
//               and its iframe live in the page DOM (a larger, page-detectable footprint).
//   'popup'    -- the classic toolbar bubble. It renders in the browser's own chrome, so the page
//               has NO handle to it at all (zero page footprint = the "safer" mode).
// Implemented purely with chrome.action.setPopup: when a popup is SET the icon opens the bubble and
// onClicked never fires; when it's CLEARED onClicked fires and we inject the overlay. The service
// worker can't read the popup's localStorage, so this one setting lives in chrome.storage.local.
function applyUiMode(mode) {
  chrome.action.setPopup({popup: mode === 'popup' ? 'src/popup/popup.html' : ''});
}
// re-applied on every service-worker spin-up (top-level), so the mode survives SW restarts
chrome.storage.local.get('ui_mode', ({ui_mode}) => applyUiMode(ui_mode || 'floating'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ui_mode) return;
  const mode = changes.ui_mode.newValue || 'floating';
  applyUiMode(mode);
  if (mode === 'popup') { // tear down any overlay that's open when the user switches to the safe mode
    chrome.tabs.query({}, tabs => tabs.forEach(t => t.id &&
      chrome.tabs.sendMessage(t.id, {closeOverlay: true}, () => void chrome.runtime.lastError)));
  }
});

// Floating mode only: clicking the icon toggles the draggable in-page overlay. (In popup mode a
// popup is set, so this listener never fires -- Chrome shows the bubble instead.)
chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, {toggleOverlay: true}, () => void chrome.runtime.lastError);
});

// --- Native messaging (opt-in full-power native engines), owned HERE in the service worker
// (connectNative() from the in-page popup iframe is torn down by Chrome). A persistent Port pipes
// both ways so a host can STREAM many frames per request (one per search depth). Keyed by port
// name. The default WASM engines need none of this; native engines require native-host/install-native.sh.
const NATIVE_HOSTS = {
  // native-messaging host names allow only [a-z0-9._] -- NO hyphens -> underscores in the app id
  'sf-native': {app: 'com.sf_native.host', label: 'Stockfish (native)'},
  'fairy-native': {app: 'com.fairy_native.host', label: 'Fairy-Stockfish (native)'},
};
const nativePorts = {};        // port name -> native stdio Port
const popupPortsByName = {};   // port name -> Set of popup Ports

function ensureNative(name) {
  if (nativePorts[name]) return nativePorts[name];
  const {app, label} = NATIVE_HOSTS[name];
  const np = chrome.runtime.connectNative(app);
  nativePorts[name] = np;
  const peers = () => popupPortsByName[name] || new Set();
  np.onMessage.addListener(frame => {
    for (const p of peers()) { try { p.postMessage(frame); } catch (e) { /* port gone */ } }
  });
  np.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    delete nativePorts[name];
    const why = `${label} native host unavailable` + (err ? ` (${err.message})` : '') +
      ' — run native-host/install-native.sh once (see the README).';
    for (const p of peers()) { try { p.postMessage({fatal: why}); } catch (e) { /* */ } }
  });
  return np;
}

chrome.runtime.onConnect.addListener(port => {
  if (!NATIVE_HOSTS[port.name]) return;
  const name = port.name;
  (popupPortsByName[name] = popupPortsByName[name] || new Set()).add(port);
  port.onDisconnect.addListener(() => {
    popupPortsByName[name].delete(port);
    // Last popup using this engine went away (you switched engines, or closed the page). Shut the
    // native host DOWN so a lingering search can't keep burning all cores and throttle the engine
    // you just selected. It relaunches on next use.
    if (popupPortsByName[name].size === 0 && nativePorts[name]) {
      try { nativePorts[name].disconnect(); } catch (e) { /* already gone */ }
      delete nativePorts[name];
    }
  });
  port.onMessage.addListener(req => {
    try {
      ensureNative(name).postMessage(req);
    } catch (e) {
      try { port.postMessage({id: req && req.id, error: String(e)}); } catch (_) { /* */ }
    }
  });
});
