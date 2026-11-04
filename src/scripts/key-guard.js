// Typing in the floating panel never reaches the page, capture phase included.
//
// Loaded at document_start, before any page script runs, so these window capture listeners are the
// first ones every event meets. Key and text events typed into the panel are composed: they leave its
// closed shadow root retargeted to the host div, and the root's own stop (getOverlayRoot in
// content-script.js) runs in the bubble phase, after every capture listener the page put on window,
// document, html or body. Those still read each typed key, each e.data and each pasted FEN
// (audit 3.1.330 PAGEA-5). The decision and the hand-back to the panel live in content-script.js
// (self.MephistoPanelTextGuard), which loads later in this same isolated world; until it does, and
// on any page that never opens the panel, this does nothing.
(() => {
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy',
                        'compositionstart', 'compositionupdate', 'compositionend']) {
        window.addEventListener(type, (e) => { self.MephistoPanelTextGuard?.(e); }, true);
    }
})();
