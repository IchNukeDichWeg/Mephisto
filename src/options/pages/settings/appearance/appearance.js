import { define } from "../../../framework/require.js";
import { SettingsPage } from "../../../util/SettingsPage.js";

class AppearanceSettings extends SettingsPage {
    init() {
        // The <option>s are built here rather than written into appearance.html, so MephistoI18n's
        // LANGUAGES stays the ONE place a language exists -- adding one there is the whole job.
        // Each is named in its own language: a list written in English does not help someone
        // looking for theirs.
        const langSelect = document.getElementById('language_select');
        if (langSelect && !langSelect.options.length) {
            for (const {code, name} of MephistoI18n.LANGUAGES) {
                langSelect.add(new Option(name, code));
            }
        }
        M.FormSelect.init(document.querySelectorAll('select'), {});
        M.Range.init(document.querySelectorAll('input[type=range]'), {});
        this.registerFormElement('pieces', 'Pieces:', 'select', 'wikipedia.svg');
        this.registerFormElement('board', 'Board:', 'select', 'brown');
        this.registerFormElement('coordinates', 'Coordinates:', 'checkbox', false);
        const theme = this.registerFormElement('theme', 'Theme:', 'select', 'system');
        theme.registerChangeListener(() => window.mephistoApplyTheme?.());
        // Re-translate immediately on change: waiting for a reload to see whether you picked the
        // right language is the one thing a language picker must not do.
        const lang = this.registerFormElement('language', 'Language:', 'select', MephistoI18n.DEFAULT_LANG);
        lang.registerChangeListener(() => window.mephistoApplyLanguage?.(lang.getValue()));
        // Arrow colours: the hex field is the SETTING (registered like any input); the native
        // colour picker beside it is a second face of the same value, synced both ways. An empty
        // field means "the shipped default" -- the panel validates at use, so junk cannot break
        // drawing. FormElement saves on 'input' events, which is exactly what the picker fires.
        const ARROW_COLORS = [
            ['arrow_color_line1', '#0a5bd3'], ['arrow_color_line2', '#0f9d58'],
            ['arrow_color_line3', '#e0a400'], ['arrow_color_line4', '#e8710a'],
            ['arrow_color_line5', '#9333ea'], ['arrow_color_forced_ours', '#d81b8c'],
            ['arrow_color_forced_theirs', '#00a693'], ['arrow_color_pv_walk', '#8f8f8f'],
            ['arrow_color_threat', '#bf0000'], ['arrow_color_book', '#14b8a6'],
            ['arrow_color_human_reply', '#a8657f'], ['arrow_color_safety_net', '#4c9f70'],
            ['arrow_color_tb', '#f59e0b'], ['arrow_color_refute', '#d1495b'],
            ['arrow_color_human_error', '#a0522d'],
        ];
        // ARROW PALETTE: Default, Colour-blind safe (MephistoConfig.ARROW_COLORBLIND) or Custom. The
        // per-family pickers below set Custom's colours and show only under it; they stay stored
        // whatever is picked, so switching away and back loses nothing. The panel reads the palette
        // (palette_color in popup.js), so nothing here rewrites the colour keys.
        const palette = this.registerFormElement('arrow_palette', 'Arrow Palette:', 'select', 'default');
        const sync_palette = () => {
            document.getElementById('arrow_custom_block')?.classList.toggle('hidden', palette.getValue() !== 'custom');
        };
        palette.registerChangeListener(sync_palette);
        sync_palette();
        // How strongly every arrow is drawn, a percentage (the panel's read_arrow_opacity). It sits with
        // the arrow colours; the readout is the `.set-val` in its own row, as on General.
        const opacity = this.registerFormElement('arrow_opacity', 'Arrow Opacity:', 'range', 75);
        opacity.registerChangeListener(() => {
            const out = opacity.elem?.closest?.('.set-row')?.querySelector('.set-val');
            if (out) out.innerText = opacity.getValue();
        });
        for (const [key, dflt] of ARROW_COLORS) {
            const el = this.registerFormElement(key, key + ':', 'input', '');
            const picker = document.getElementById(key + '_picker');
            const text = document.getElementById(key + '_input');
            if (!picker || !text || el.missing) continue;
            const sync = () => { picker.value = /^#[0-9a-fA-F]{6}$/.test(text.value) ? text.value : dflt; };
            sync();
            el.registerChangeListener(sync);
            picker.addEventListener('input', () => {
                text.value = picker.value;
                text.dispatchEvent(new Event('input', {bubbles: true})); // the event FormElement saves on
            });
        }
    }
}

define({
    title: 'Appearance',
    page: new AppearanceSettings()
});