export class FormElement {
    name;
    desc;
    type;
    default;
    valueType;
    elem;

    constructor(name, description, type, defaultValue) {
        this.name = name;
        this.desc = description;
        this.type = type;
        this.default = defaultValue;
        this.valueType = typeof defaultValue;
        this.elem = document.getElementById(`${name}_${type}`);
    }

    registerChangeListener(fn) {
        if (this.type === 'input' || this.type === 'range') {
            this.elem.addEventListener('input', fn);
        } else if (this.type === 'checkbox') {
            this.elem.addEventListener('change', fn);
        } else if (this.type === 'select') {
            this.elem.addEventListener('change', fn);
        }
    }

    getValue() {
        if (this.type === 'input' || this.type === 'range') {
            return this.elem.value;
        } else if (this.type === 'checkbox') {
            return this.elem.checked;
        } else if (this.type === 'select') {
            return this.elem.value;
        }
    }

    setValue(val) {
        if (this.type === 'input' || this.type === 'range') {
            this.elem.value = val;
            this.elem.dispatchEvent(new Event('input'));
        } else if (this.type === 'checkbox') {
            this.elem.checked = val;
            this.elem.dispatchEvent(new Event('change'));
        } else if (this.type === 'select') {
            // A stored value whose <option> no longer exists -- e.g. an engine dropped since it was
            // saved, exactly the migration case popup.js handles and this page did not -- used to
            // throw here. setValue runs inside SettingsPage.pullConfigValues' forEach, so that throw
            // aborted the loop: every field AFTER this one silently kept its markup default and the
            // page rendered half-initialized. Fall back to this element's own default instead.
            // Scanning options also beats the old querySelector, which interpolated `val` straight
            // into the selector -- a stored value containing a quote threw SyntaxError just as fatally.
            const pick = (v) => [...this.elem.options].find(o => o.value === String(v));
            const opt = pick(val) || pick(this.default);
            if (!opt) return; // no default option either -- keep the markup's own rather than throw
            this.elem.value = opt.value;
            this.elem.parentElement.querySelector('input').value = opt.innerText;
            this.elem.dispatchEvent(new Event('change'));
        }
    }
}
