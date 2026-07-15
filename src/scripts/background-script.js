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
  port.onDisconnect.addListener(() => popupPortsByName[name].delete(port));
  port.onMessage.addListener(req => {
    try {
      ensureNative(name).postMessage(req);
    } catch (e) {
      try { port.postMessage({id: req && req.id, error: String(e)}); } catch (_) { /* */ }
    }
  });
});
