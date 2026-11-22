// WARN WHEN A NUMBER CANNOT WORK. Threads above the machine's cores make the engine SLOWER -- the
// searchers fight each other for the same cores -- and hash beyond memory thrashes to disk. Both are
// knowable, so a field that quietly makes things worse gets one amber sentence instead.
//
// The honesty caveat, written down so nobody re-derives it: navigator.deviceMemory is CAPPED AT 8 by
// spec. A machine reporting 8 may have 64GB, so the hash warning only fires when the report is UNDER
// the cap -- there it is a real ceiling. Cores are reported truthfully and always checked.
// Translated through set.warn_threads / set.warn_hash, English when the tables are absent (audit 3.1.333 OPTIONSPAGES-7).
const t = (k, d, v) => (self.MephistoI18n ? self.MephistoI18n.t(k, d, v) : d.replace(/\{(\w+)\}/g, (m, x) => (x in v ? v[x] : m)));
export function threadsWarning(n) {
    const cores = navigator.hardwareConcurrency || 0;
    if (!cores || !(n > cores)) return '';
    return t('set.warn_threads', 'This machine has {cores} cores - {n} threads will fight each other and search slower, not faster.', {cores, n});
}

export function hashWarning(mb) {
    const gb = navigator.deviceMemory || 0;
    if (!gb || gb >= 8) return '';            // at the spec cap the real memory is unknowable
    if (!(mb > gb * 1024 / 2)) return '';     // half of a small machine is already generous for hash
    return t('set.warn_hash', 'This machine reports {gb}GB of memory - a {mb}MB hash will push it into swapping.', {gb, mb});
}

// One line per page: both checks, joined, into a .limit-warn element that hides itself when empty.
export function refreshLimitWarnings(el, threads, hashMb) {
    if (!el) return;
    el.textContent = [threadsWarning(+threads || 0), hashWarning(+hashMb || 0)].filter(Boolean).join(' ');
}
