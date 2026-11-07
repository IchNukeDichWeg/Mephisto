import { require } from "./framework/require.js";

let registerPageScript;

// dark mode: a single class on <html>, toggled from the Appearance settings. Applied before
// anything renders and re-applied live when the toggle changes (window.mephistoApplyTheme).
function applyTheme() {
    const dark = JSON.parse(MephistoConfig.get('dark_mode') || 'false');
    document.documentElement.classList.toggle('dark', dark);
}
applyTheme();
MephistoConfig.ready.then(applyTheme); // re-apply once chrome.storage (source of truth) is loaded
window.mephistoApplyTheme = applyTheme;

// UI language, same shape as the theme: applied to whatever is on screen and re-applied live when
// the Appearance setting changes. This page swaps its content per route, so each page re-applies on
// render too (SettingsPage.onInit) -- this covers the shell (sidebar, title) and a live change.
async function applyLanguage(lang) {
    await MephistoI18n.use(lang || JSON.parse(MephistoConfig.get('language') || '"en"'));
    MephistoI18n.apply(document);
    document.documentElement.lang = MephistoI18n.lang;
    // Materialize copies data-tooltip into its own element when a tooltip is created, so an already
    // initialised tooltip keeps the old text until it is rebuilt.
    // The SAME 250 ms as SettingsPage.decorateTooltips: the Appearance page's language select fires
    // this while its form is filled (and on Restore Defaults), and rebuilding at 1000 put every
    // tooltip on that page back to the one-second wait decorateTooltips exists to remove (audit
    // 3.1.331 APPEARANCE-2).
    M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 250});
}
window.mephistoApplyLanguage = applyLanguage;

document.addEventListener('DOMContentLoaded', function () {
    applyTheme();
    let activeScrollspies;

    // init materialize. The menu is a FLAT list since 3.1.253 -- no accordion to initialise, and
    // nothing else on these pages uses one.
    const mSidenav = M.Sidenav.init(document.querySelectorAll('.sidenav'), {});

    // page injection logic
    const contentElem = document.querySelector('#content .container');
    const titleElem = document.getElementById('title');
    const headElem = document.getElementById('header');
    const stylesheetsElem = document.querySelector('head');

    function onClick(e) {
        injectPage(e.target.hash.substring(1));
        if (e.target.id === 'logo-container') {
            e.target.parentElement.classList.remove('active');
            document.getElementById('about').parentElement.classList.add('active');
        }
    }

    function updateActiveTab(elem) {
        location.hash = elem.hash;
        document.querySelectorAll('#nav-mobile li').forEach(elem => {
            if (!elem.classList.contains('open')) {
                elem.classList.remove('active');
            }
        });
        while (elem.id !== 'nav-mobile') {
            if (elem.tagName === 'LI') {
                elem.classList.add('active');
            } else if (elem.classList.contains('collapsible') && !elem.children[0].classList.contains('open')) {
                elem.M_Collapsible.close();
                elem.M_Collapsible.open();
            }
            elem = elem.parentElement;
        }
    }

    // Every page's nav entry carries its path as its id, so a nav entry is also the test of whether
    // a page exists. A hash nobody has any more -- a bookmark from before a page was renamed, a typo,
    // an old link -- used to throw here (getElementById returns null, updateActiveTab reads .hash off
    // it) and leave a BLANK options page with no way back except editing the URL by hand.
    const DEFAULT_PAGE = 'settings/general';

    // A LOAD IS SUPERSEDED, NOT QUEUED. Every step below awaits the page's html, css or module, so a
    // double-click on a nav entry, or a click while the first route was still loading, ran two loads
    // at once: both initialised the SECOND load's markup (every listener twice: two exports per
    // click, two table downloads), or the slower page's init ran on the faster page's DOM under the
    // wrong title. Only the newest load touches the page after an await, and the page's own onInit
    // gets the same test for its awaits (audit 3.1.331 OPTIONSFRAMEWORK-1).
    let navGen = 0;
    let loadingPath = null;   // the page the newest load is for: the hashchange router below skips it

    async function injectPage(pagePath) {
        const navEntry = document.getElementById(pagePath);
        if (!navEntry) {
            if (pagePath === DEFAULT_PAGE) return;   // the default itself is gone: nothing to fall back to
            // replaced, not pushed: Back is routed now (below), and Back onto a dead hash that pushed
            // the default again would land the user on the same dead entry every time
            history.replaceState(null, '', '#' + DEFAULT_PAGE);
            return injectPage(DEFAULT_PAGE);
        }
        const gen = ++navGen, isCurrent = () => gen === navGen;
        loadingPath = pagePath;
        updateActiveTab(navEntry);
        const title = pagePath.substring(pagePath.lastIndexOf('/') + 1);
        const path = pagePath.substring(0, pagePath.lastIndexOf('/') + 1) + title;
        const componentPath = `pages/${path}/${title}`;

        // inject html
        const pageBody = await require(componentPath, 'html');
        if (!isCurrent()) return;
        contentElem.innerHTML = pageBody.innerHTML;
        activeScrollspies?.forEach(scrollspy => scrollspy.destroy());
        activeScrollspies = M.ScrollSpy.init(document.querySelectorAll('.scrollspy'), {});
        headElem.scrollIntoView(true);

        // disable cached stylesheets
        Array.from(document.getElementsByClassName('page-stylesheet'))
            .forEach((stylesheet) => stylesheet.disabled = true);

        // inject css OR re-enable cached css
        const pageStylesheet = document.getElementById(`${componentPath}-stylesheet`);
        if (pageStylesheet) {
            pageStylesheet.disabled = false;
        } else {
            const pageStyle = await require(componentPath, 'css');
            if (!isCurrent()) return;
            stylesheetsElem.appendChild(pageStyle);
        }

        // inject js
        const pageModule = await require(componentPath);
        if (!isCurrent()) return;
        pageModule.page?.onInit(isCurrent);

        // inject page title
        titleElem.innerText = pageModule.title;

        paintRanges();            // teal-fill the slider tracks up to the thumb (dark CSS reads var(--fill))
        setTimeout(paintRanges, 150); // fallback: some range values are set just after onInit
    }

    // set --fill (0-100%) on a range from its value; the dark-mode slider CSS paints the teal fill to it
    function paintRange(r) {
        const min = +r.min || 0, max = +r.max || 100;
        r.style.setProperty('--fill', ((r.value - min) / (max - min) * 100) + '%');
    }
    function paintRanges() {
        document.querySelectorAll('input[type=range]').forEach(paintRange);
    }
    document.addEventListener('input', e => { // live update while dragging any slider
        if (e.target.matches?.('input[type=range]')) paintRange(e.target);
    });

    document.querySelectorAll('#nav-mobile a.menu-item').forEach(elem => {
        elem.addEventListener('click', e => onClick(e));
    });

    // BACK AND FORWARD ROUTE TOO. Every visit sets location.hash, so every visit is a history entry,
    // but only a nav click ever loaded a page: Back changed the URL and left the old page on screen,
    // on Analysis with its engines already freed by its own hashchange teardown (dead arrow keys),
    // and F5 then opened a page other than the one shown (audit 3.1.331 OPTIONSFRAMEWORK-2). The
    // hash a load sets for itself, and the one a nav click's link sets after its handler, name the
    // page already loading and are skipped.
    window.addEventListener('hashchange', () => {
        const pagePath = location.hash.substring(1) || DEFAULT_PAGE;
        if (pagePath !== loadingPath) injectPage(pagePath);
    });

    injectPage(location.hash.substring(1) || DEFAULT_PAGE);

    // THE PANEL'S "CLICK TO INSTALL" WITH THIS PAGE ALREADY OPEN (audit 3.1.331 UPDATER-5). The worker
    // raises a flag and calls openOptionsPage, which only brings an open options tab to the front: it
    // neither reloads it nor changes its page, so on Game Review nothing happened. The tab that comes
    // to the front (visible now or within a moment) goes to Settings > General, which takes the flag.
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !(ch.mephisto_autostart_update?.newValue || ch.mephisto_focus_updates?.newValue)) return;
        const go = () => injectPage(DEFAULT_PAGE);
        if (document.visibilityState === 'visible') return go();
        const seen = () => {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', seen);
            go();
        };
        document.addEventListener('visibilitychange', seen);
        setTimeout(() => document.removeEventListener('visibilitychange', seen), 3000);
    });
});