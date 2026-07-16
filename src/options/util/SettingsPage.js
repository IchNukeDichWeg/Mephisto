import { FormElement } from "./FormElement.js";

export class SettingsPage {
    resetButton;
    formElements;

    constructor() {
        if (this.constructor === SettingsPage) {
            throw new Error("Can't instantiate abstract class!");
        }
        this.formElements = [];
    }

    init() {
        throw new Error("init() must be implemented!");
    }

    async onInit() {
        this.resetButton = document.getElementById('reset_btn');
        this.resetButton.addEventListener('click', () => this.onResetConfigValues());

        // chrome.storage.local is the source of truth (the panel writes only there). Wait for the
        // cache before touching the forms -- reading early gave stale values, and any later change
        // then pushed those stale values back, silently reverting settings made in the panel.
        await MephistoConfig.ready;
        this.init();
        this.pullConfigValues();
    }

    clearConfigValues() {
        this.formElements.forEach(formElement => {
            MephistoConfig.remove(formElement.name);
        });
    }

    // localstorage values push/pull
    pullConfigValues() {
        this.formElements.forEach(formElement => {
            const localStorageVal = MephistoConfig.get(formElement.name);
            if (localStorageVal) {
                formElement.setValue(JSON.parse(localStorageVal));
            } else {
                formElement.setValue(formElement.default);
            }
        });
    }

    pushConfigValues() {
        this.formElements.forEach(formElement => {
            const formValue = (formElement.valueType === 'string')
                ? `"${formElement.getValue()}"`
                : formElement.getValue();
            MephistoConfig.set(formElement.name, formValue);
        });
    }

    // register form element
    registerFormElement(name, description, type, defaultValue) {
        const formElement = new FormElement(name, description, type, defaultValue);
        formElement.registerChangeListener(() => {
            const formValue = (formElement.valueType === 'string')
                ? `"${formElement.getValue()}"`
                : formElement.getValue();
            MephistoConfig.set(formElement.name, formValue);
        });
        this.formElements.push(formElement);
        return formElement;
    }

    // on event callbacks
    onResetConfigValues() {
        this.clearConfigValues();
        this.pullConfigValues();
    }
}
