import { define } from "../../../framework/require.js";
import { SettingsPage } from "../../../util/SettingsPage.js";

class AppearanceSettings extends SettingsPage {
    init() {
        M.FormSelect.init(document.querySelectorAll('select'), {});
        this.registerFormElement('pieces', 'Pieces:', 'select', 'wikipedia.svg');
        this.registerFormElement('board', 'Board:', 'select', 'brown');
        this.registerFormElement('coordinates', 'Coordinates:', 'checkbox', false);
        const darkToggle = this.registerFormElement('dark_mode', 'Dark Mode:', 'checkbox', false);
        darkToggle.registerChangeListener(() => window.mephistoApplyTheme?.());
    }
}

define({
    title: 'Appearance',
    page: new AppearanceSettings()
});