import {define} from "../../../framework/require.js";
import {SettingsPage} from "../../../util/SettingsPage.js";

class GeneralSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        M.Range.init(document.querySelectorAll('input[type=range]'), {});
        M.Tooltip.init(document.querySelectorAll('.tooltipped'), {enterDelay: 1000});
        const engine_select = this.registerFormElement('engine', 'Engine:', 'select', 'stockfish-dev-nnue');
        const variant_select = this.registerFormElement('variant', 'Variant:', 'select', 'chess');
        const elo_input = this.registerFormElement('elo', 'Elo:', 'input', 0);
        this.registerFormElement('compute_time', 'Stockfish Compute Time (ms):', 'input', 300);
        this.registerFormElement('fen_refresh', 'Fallback Poll Interval (ms):', 'input', 1000);
        const multipv_range = this.registerFormElement('multiple_lines', 'Multiple Lines:', 'range', 1);
        const threads_range = this.registerFormElement('threads', 'Threads:', 'range', 8);
        const memory_range = this.registerFormElement('memory', 'Memory:', 'range', 512);
        this.registerFormElement('computer_evaluation', 'Show Computer Evaluation:', 'checkbox', true);
        this.registerFormElement('threat_analysis', 'Show Threat Analysis', 'checkbox', false);
        this.registerFormElement('simon_says_mode', '"Hand and Brain" Mode:', 'checkbox', false);
        this.registerFormElement('autoplay', 'Autoplay:', 'checkbox', false);
        this.registerFormElement('premove', 'Premove:', 'checkbox', false);
        this.registerFormElement('help_mode', 'Help Mode:', 'checkbox', false);
        this.registerFormElement('humanize', 'Humanize:', 'checkbox', false);
        this.registerFormElement('clock_mode', 'Clock Mode:', 'checkbox', false);
        this.registerFormElement('mirror_mode', 'Mirror Time:', 'checkbox', false);
        this.initHumanizeMix();
        this.initUiMode();
        this.registerFormElement('puzzle_mode', 'Puzzle Mode:', 'checkbox', false);
        this.registerFormElement('python_autoplay_backend', 'Python Autoplay Backend:', 'checkbox', false);
        this.registerFormElement('think_time', 'Simulated Think Time (ms):', 'input', 0);
        this.registerFormElement('think_variance', 'Simulated Think Variance (ms):', 'input', 0);
        this.registerFormElement('move_time', 'Simulated Move Time (ms):', 'input', 200);
        this.registerFormElement('move_variance', 'Simulated Move Variance (ms):', 'input', 50);
        const engineLabelTooltiped = document.querySelector('#engine-label-tooltiped');
        const engineLabelUntooltiped = document.querySelector('#engine-label-untooltiped');
        for (const range of [multipv_range, threads_range, memory_range]) {
            range.registerChangeListener(() => {
                let section = range.elem;
                while (!section.classList.contains('section')) {
                    section = section.parentElement
                }
                section.querySelector('.value').innerText = range.getValue();
            });
        }
        engine_select.registerChangeListener(() => {
            let section = variant_select.elem;
            while (!section.classList.contains('section')) {
                section = section.parentElement
            }
            if (['fairy-stockfish-14-nnue', 'fairy-native'].includes(engine_select.getValue())) {
                section.classList.remove('hidden');
            } else {
                section.classList.add('hidden');
                // Chess960 survives an engine switch: every mainline Stockfish plays it via
                // UCI_Chess960 (sent at engine init). Only fairy-only variants reset.
                if (!['chess', 'fischerandom'].includes(variant_select.getValue())) {
                    variant_select.setValue('chess');
                }
            }
            // Elo cap range follows the engine (Stockfish ignores out-of-range UCI_Elo). Keep the
            // input min at 0 so "0 = full strength" stays enterable; only cap the top per engine.
            const ELO_RANGE = { 'stockfish-11-hce': [1350, 2850], 'fairy-stockfish-14-nnue': [500, 2850], 'fairy-native': [500, 2850], 'sf-native': [1320, 3190] };
            elo_input.elem.max = (ELO_RANGE[engine_select.getValue()] || [1320, 3190])[1];
            if (engine_select.getValue() === 'remote') {
                engineLabelTooltiped.classList.remove('hidden');
                engineLabelUntooltiped.classList.add('hidden');
            } else {
                engineLabelTooltiped.classList.add('hidden');
                engineLabelUntooltiped.classList.remove('hidden');
            }
        })
    }

    // Humanize move mix: five independent slider+number pairs. No auto-rescaling -- the user
    // balances them by hand, and the Total row shows the sum plus what's off: "90 (-10)" means
    // add 10 somewhere, "110 (+10)" means remove 10. (The popup normalizes by the sum when
    // picking, so an off-100 mix still behaves proportionally in the meantime.) NOT FormElements:
    // one logical setting spans two inputs per row. Values persist per-key in localStorage; the
    // popup reads them fresh on every pick, so edits apply to the very next move.
    // Panel Style: 'floating' (in-page overlay) or 'popup' (toolbar bubble = no page footprint).
    // Unlike every other setting this one lives in chrome.storage.local, NOT localStorage: the
    // background service worker flips the toolbar popup on/off (chrome.action.setPopup) and can't
    // read the popup page's localStorage. Writing it fires chrome.storage.onChanged in the worker.
    initUiMode() {
        const sel = document.getElementById('ui_mode_select');
        if (!sel) return; // stale cached page html
        chrome.storage.local.get('ui_mode', ({ui_mode}) => { sel.value = ui_mode || 'floating'; });
        sel.addEventListener('change', () => chrome.storage.local.set({ui_mode: sel.value}));
    }

    initHumanizeMix() {
        const MIX = [
            ['humanize_top', 50], ['humanize_second', 40], ['humanize_third', 4],
            ['humanize_mistake', 5], ['humanize_blunder', 1],
        ];
        const rows = MIX.map(([key, dflt]) => ({
            key, dflt,
            range: document.getElementById(`${key}_mixrange`),
            num: document.getElementById(`${key}_mixnum`),
        }));
        const total = document.getElementById('humanize_mix_total');
        if (!rows.every(r => r.range && r.num) || !total) return; // stale cached page html
        const paint = (el) => // dark-mode slider fill (options.js paints only on user input)
            el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
        const load = (key, dflt) => {
            try {
                const v = JSON.parse(localStorage.getItem(key));
                return (v != null && isFinite(+v)) ? +v : dflt;
            } catch (e) {
                return dflt;
            }
        };

        const updateTotal = () => {
            const sum = rows.reduce((a, r) => a + (+r.range.value), 0);
            const diff = sum - 100;
            total.textContent = (diff === 0) ? '100 ✓' : `${sum} (${diff > 0 ? '+' : ''}${diff})`;
            total.classList.toggle('ok', diff === 0);
            total.classList.toggle('off', diff !== 0);
        };

        const set = (row, val, persist = true) => {
            val = Math.min(100, Math.max(0, Math.round(+val) || 0));
            row.range.value = val;
            row.num.value = val;
            paint(row.range);
            if (persist) localStorage.setItem(row.key, val);
            updateTotal();
        };

        rows.forEach(r => {
            set(r, load(r.key, r.dflt), false); // initial sync, don't churn storage on page open
            r.range.addEventListener('input', () => set(r, r.range.value));
            r.num.addEventListener('change', () => set(r, r.num.value));
        });
    }
}

define({
    title: 'General Settings',
    page: new GeneralSettings()
});
