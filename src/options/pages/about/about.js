import { define } from "../../framework/require.js";

define({
    title: 'About',
    // The page is plain markup with no controls, so nothing else would translate the one line on it
    // that is a key (the pointer to the README's error codes).
    page: {onInit() { MephistoI18n.apply(document); }}
});
