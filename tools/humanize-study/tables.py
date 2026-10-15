"""Stage C -> the runtime error-rate tables Humanize scales its shares with.

usage: python3 tables.py <agg dir> [<holdout agg dir>] [--js]

The logistic fit (fit.py) misses the TC x clock and TC x phase shape badly on hold-out (chi2/dof
60-120), because it has no interaction terms. This fits the multiplicative model those margins
actually need, by iterative proportional fitting over the per-move cells:

    rate(band, tc, phase, winbin, clock) = A[band,tc] * P[tc,phase] * W[tc,winbin] * C[tc,clock]

IPF reproduces every one of those four margins exactly in-sample, so the check that matters is the
hold-out month. Separately for inaccuracy+, mistake+ and blunder. --js prints the tables the panel
ships (popup.js HUMANIZE_TC_TABLES): per class, the TC level by rating band and the clock and phase
factors per TC, all relative to the n-weighted BLITZ mean at that band, so a user's share keeps
meaning "this rate in an average blitz game" and every other TC, clock and phase scales from it.
The win% factor is fitted (it de-confounds the other three: a low clock is also a decided position)
but is not shipped; the winning-position guard owns that dimension.
"""
import csv, sys, json, math, collections as C

CLASSES = ('e1', 'e2', 'e3')
MIN_CELL = 5000   # moves; a band x TC cell below this ships the pooled TC ratio
TCS = ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical')
PHASES = ('o', 'm', 'e')


def load(path):
    rows = []
    for r in csv.DictReader(open(path)):
        rows.append(dict(band=int(r['band']), tc=r['tc'], ph=r['phase'], win=int(r['winbin']),
                         clk=int(r['clockbin']), n=float(r['n']),
                         e1=float(r['e1']), e2=float(r['e2']), e3=float(r['e3'])))
    return rows


MARGINS = (('band', 'tc'), ('tc', 'ph'), ('tc', 'win'), ('tc', 'clk'))


def fit(rows, k, iters=60):
    f = {m: C.defaultdict(lambda: 1.0) for m in MARGINS}
    obs = {m: C.defaultdict(float) for m in MARGINS}
    for r in rows:
        for m in MARGINS:
            obs[m][tuple(r[x] for x in m)] += r[k]

    def pred(r):
        p = 1.0
        for m in MARGINS:
            p *= f[m][tuple(r[x] for x in m)]
        return p

    for _ in range(iters):
        for m in MARGINS:
            exp = C.defaultdict(float)
            for r in rows:
                exp[tuple(r[x] for x in m)] += r['n'] * pred(r)
            for key, e in exp.items():
                if e > 0:
                    f[m][key] *= obs[m][key] / e if obs[m][key] > 0 else 1e-6
    return f, pred


def check(rows, pred, k, label):
    out = []
    for m in (('band', 'tc'), ('tc', 'clk'), ('tc', 'ph')):
        o, e, n = C.defaultdict(float), C.defaultdict(float), C.defaultdict(float)
        for r in rows:
            key = tuple(r[x] for x in m)
            o[key] += r[k]; e[key] += r['n'] * pred(r); n[key] += r['n']
        chi, cnt, within = 0.0, 0, 0
        for key in o:
            if n[key] < 500:
                continue
            p = e[key] / n[key]
            var = n[key] * p * (1 - p)
            if var <= 0:
                continue
            z = (o[key] - e[key]) / math.sqrt(var)
            chi += z * z; cnt += 1; within += abs(z) <= 2
        out.append(f"{'x'.join(m)} {within / max(cnt, 1):.0%} within 2 SE (chi2/dof {chi / max(cnt, 1):.2f}, {cnt})")
    print(f'  {label} {k}: ' + '; '.join(out))


def tables(rows, fits):
    """Per class: level[band][tc] relative to that band's blitz mean, clock[tc][bin], phase[tc][ph]."""
    out = {}
    for k in CLASSES:
        f, pred = fits[k]
        n_tc = C.defaultdict(float); wbar = {}
        for tc in TCS:
            num = den = 0.0
            for r in rows:
                if r['tc'] == tc:
                    num += r['n'] * f[('tc', 'win')][(tc, r['win'])]; den += r['n']
            wbar[tc] = num / den if den else 1.0
        # mean phase*clock factor in each TC over its own move mix -> clock/phase shipped relative to it
        mix = {}
        for tc in TCS:
            num = den = 0.0
            for r in rows:
                if r['tc'] == tc:
                    num += r['n'] * f[('tc', 'ph')][(tc, r['ph'])] * f[('tc', 'clk')][(tc, r['clk'])]
                    den += r['n']
            mix[tc] = num / den if den else 1.0
        bands = sorted({r['band'] for r in rows})
        nbt = C.defaultdict(float)
        for r in rows:
            nbt[(r['band'], r['tc'])] += r['n']
        level, raw = {}, {}
        for b in bands:
            # an average game of each TC at this band: A * Wbar * mean(P*C)
            avg = {tc: f[('band', 'tc')][(b, tc)] * wbar[tc] * mix[tc] for tc in TCS
                   if (b, tc) in f[('band', 'tc')]}
            if 'blitz' not in avg:
                continue
            raw[b] = {tc: v / avg['blitz'] for tc, v in avg.items()}
        # A THIN CELL IS NOT A RATE. Under MIN_CELL moves (2800 classical, 400 ultrabullet) the band's
        # own ratio is noise, so it takes the n-weighted ratio of every band for that TC instead.
        pooled = {}
        for tc in TCS:
            num = sum(raw[b][tc] * nbt[(b, tc)] for b in raw if tc in raw[b])
            den = sum(nbt[(b, tc)] for b in raw if tc in raw[b])
            pooled[tc] = num / den if den else 1.0
        for b in raw:
            level[b] = {tc: round(raw[b][tc] if nbt[(b, tc)] >= MIN_CELL and tc in raw[b] else pooled[tc], 3)
                        for tc in TCS}
        clock = {tc: [round(f[('tc', 'clk')][(tc, i)] / mix[tc] * 1, 4) for i in range(8)] for tc in TCS}
        phase = {tc: [round(f[('tc', 'ph')][(tc, p)], 4) for p in PHASES] for tc in TCS}
        # clock*phase are only meaningful as a product relative to mix; renormalise the pair so that
        # the n-weighted mean of clock[c]*phase[p] in each TC is exactly 1
        for tc in TCS:
            num = den = 0.0
            for r in rows:
                if r['tc'] == tc:
                    num += r['n'] * clock[tc][r['clk']] * phase[tc][PHASES.index(r['ph'])]; den += r['n']
            s = num / den
            phase[tc] = [round(v / s, 4) for v in phase[tc]]
        out[k] = {'level': level, 'clock': clock, 'phase': phase}
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    rows = load(f'{args[0]}/cells_strict_rw.csv')
    fits = {k: fit(rows, k) for k in CLASSES}
    for k in CLASSES:
        check(rows, fits[k][1], k, 'in-sample')
    if len(args) > 1:
        hold = load(f'{args[1]}/cells_strict_rw.csv')
        for k in CLASSES:
            check(hold, fits[k][1], k, 'HOLD-OUT ')
    t = tables(rows, fits)
    if '--js' in sys.argv:
        print(json.dumps(t, separators=(',', ':')))
    else:
        for k in CLASSES:
            print(k, 'clock', t[k]['clock']); print(k, 'phase', t[k]['phase'])
            print(k, 'level 1400', t[k]['level'].get(1400))


if __name__ == '__main__':
    main()
