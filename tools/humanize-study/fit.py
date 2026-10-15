#!/usr/bin/env python3
"""Stage C, step 4: fit the small humanize model and write humanize-model.json.

Model (humanize-redesign.md, "From results to parameters"): one logistic regression per threshold,
P(error >= inaccuracy), P(error >= mistake), P(blunder), on
  r      (mover band midpoint - 1500) / 500, and r^2
  L      log2(estimated duration / 300 s): one unit per doubling of the time control
  r*L    so the rating effect can differ by time control
  phase  middlegame and endgame dummies (opening = baseline)
  win    dummies for mover win% before <20, 20-40, 60-80, >80 (40-60 = baseline); mate-on-board
         positions are not in the fit (mate_conversion covers them)
  c, c^2 c = log2(clock left / base) at the clock bin's midpoint
  c*L    owner decision 8: the clock effect must be free to differ by time control
Fitted on aggregate.py's grouped cells by IRLS (exact binomial maximum likelihood on the binned
predictors; numpy only). Forced moves and berserk moves are not in the cells.

Hold-out (--holdout, cells of ANOTHER month built the same way): the fitted model predicts every
held-out cell, and the predicted vs observed rates are compared on the margins that matter
(band x TC, TC x clock bin, TC x phase, win bin) with the held-out binomial SE. The report gives the
share of margins within 2 SE (about 95% if the model is right) and chi-square / dof.

Output JSON (compact, a few KB): feature definitions and centering, coefficients and SEs per
threshold, plus from the aggregate tables: type mix per band x TC (all errors) and per TC x
severity, punish rates, conversion, mate conversion by N, and the raw TC x clock curve.
"""
import argparse
import csv
import datetime
import json
import math
import os
import sys

import numpy as np

import study_core as sc

THRESHOLDS = (('inaccuracy+', 'e1'), ('mistake+', 'e2'), ('blunder', 'e3'))
FEATURES = ('const', 'r', 'r2', 'L', 'rL', 'mid', 'end', 'w0', 'w1', 'w3', 'w4', 'c', 'c2', 'cL')
R_CENTER, R_SCALE = 1500.0, 500.0
L_CENTER = math.log2(300.0)


def band_mid(band):
    # 400 is "<600" and 2800 is "2800+": their midpoints are a guess at where those players sit
    return {400: 500.0, 2800: 2900.0}.get(band, band + 100.0)


def features(band, dbucket, phase, winbin, clockbin):
    r = (band_mid(band) - R_CENTER) / R_SCALE
    L = dbucket / 2.0 - L_CENTER
    c = math.log2(sc.CLOCK_MID[clockbin])
    return [1.0, r, r * r, L, r * L, float(phase == 'm'), float(phase == 'e'),
            float(winbin == '0'), float(winbin == '1'), float(winbin == '3'), float(winbin == '4'),
            c, c * c, c * L]


def load_cells(path):
    rows = []
    with open(path) as f:
        for row in csv.DictReader(f):
            if row['winbin'] in ('M+', 'M-') or int(row['clockbin']) < 0:
                continue
            n = float(row['n'])
            if n <= 0:
                continue
            rows.append({'band': int(row['band']), 'tc': row['tc'], 'db': int(row['dbucket']), 'phase': row['phase'],
                         'winbin': row['winbin'], 'clockbin': int(row['clockbin']), 'n': n,
                         'e1': float(row['e1']), 'e2': float(row['e2']), 'e3': float(row['e3'])})
    return rows


def design(rows):
    return np.array([features(r['band'], r['db'], r['phase'], r['winbin'], r['clockbin']) for r in rows])


def irls(X, y, n, ridge=1e-6, iters=60, tol=1e-10):
    """Grouped binomial logistic regression. Ridge is only there to keep a cell-starved pilot
    solvable; at 1e-6 against counts in the millions it changes nothing measurable."""
    beta = np.zeros(X.shape[1])
    p0 = min(max(y.sum() / n.sum(), 1e-6), 1 - 1e-6)
    beta[0] = math.log(p0 / (1 - p0))
    prev = None
    for it in range(iters):
        eta = X @ beta
        p = 1 / (1 + np.exp(-eta))
        w = n * p * (1 - p)
        w = np.maximum(w, 1e-12)
        z = eta + (y - n * p) / w
        H = X.T @ (X * w[:, None]) + ridge * np.eye(X.shape[1])
        beta_new = np.linalg.solve(H, X.T @ (w * z))
        dev = deviance(X, beta_new, y, n)
        if prev is not None and abs(prev - dev) < tol * max(1.0, abs(dev)):
            beta = beta_new
            break
        beta, prev = beta_new, dev
    eta = X @ beta
    p = 1 / (1 + np.exp(-eta))
    H = X.T @ (X * (n * p * (1 - p))[:, None]) + ridge * np.eye(X.shape[1])
    cov = np.linalg.pinv(H)
    return beta, np.sqrt(np.maximum(np.diag(cov), 0)), it + 1


def deviance(X, beta, y, n):
    p = np.clip(1 / (1 + np.exp(-(X @ beta))), 1e-12, 1 - 1e-12)
    with np.errstate(divide='ignore', invalid='ignore'):
        t1 = np.where(y > 0, y * np.log(y / (n * p)), 0.0)
        t2 = np.where(n - y > 0, (n - y) * np.log((n - y) / (n * (1 - p))), 0.0)
    return float(2 * np.sum(t1 + t2))


def margins(rows, pred, col):
    """Observed vs predicted on the margins, with the observed binomial SE at the predicted rate."""
    keys = {
        'band x tc': lambda r: (r['band'], r['tc']),
        'tc x clock': lambda r: (r['tc'], sc.CLOCK_MID[r['clockbin']]),
        'tc x phase': lambda r: (r['tc'], r['phase']),
        'winbin': lambda r: (r['winbin'],),
    }
    out = {}
    for name, kf in keys.items():
        acc = {}
        for r, p in zip(rows, pred):
            k = kf(r)
            a = acc.setdefault(k, [0.0, 0.0, 0.0])
            a[0] += r['n']
            a[1] += r[col]
            a[2] += r['n'] * p
        out[name] = acc
    return out


def compare(rows, pred, col, min_n):
    res = {}
    for name, acc in margins(rows, pred, col).items():
        zs = []
        worst = []
        for k, (n, obs, exp) in acc.items():
            if n < min_n:
                continue
            pe = exp / n
            s = math.sqrt(max(pe * (1 - pe), 1e-12) / n)
            z = (obs / n - pe) / s
            zs.append(z)
            worst.append((abs(z), k, obs / n, pe, n))
        worst.sort(reverse=True)
        if zs:
            res[name] = {'margins': len(zs), 'within_2se': sum(1 for z in zs if abs(z) < 2) / len(zs),
                         'chi2_per_dof': sum(z * z for z in zs) / len(zs),
                         'worst': [{'key': list(map(str, w[1])), 'obs': round(w[2], 5), 'pred': round(w[3], 5),
                                    'n': int(w[4]), 'z': round(w[0], 1)} for w in worst[:3]]}
    return res


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def tables_for_json(tdir, min_n):
    out = {}
    tm = read_csv(os.path.join(tdir, 'type_mix.csv'))
    types = [c[2:] for c in (tm[0].keys() if tm else []) if c.startswith('p_')]
    by_bt, by_ts = {}, {}
    for row in tm:
        n = int(row['n_errors'])
        k = (row['band'], row['tc'])
        a = by_bt.setdefault(k, [0] + [0.0] * len(types))
        b = by_ts.setdefault((row['tc'], row['severity']), [0] + [0.0] * len(types))
        for acc in (a, b):
            acc[0] += n
            for i, t in enumerate(types):
                acc[i + 1] += n * float(row['p_' + t])
    out['type_order'] = types
    out['type_mix_band_tc'] = {f'{b}|{t}': [v[0]] + [round(x / v[0], 4) for x in v[1:]]
                               for (b, t), v in by_bt.items() if v[0] >= min_n}
    out['type_mix_tc_severity'] = {f'{t}|{s}': [v[0]] + [round(x / v[0], 4) for x in v[1:]]
                                   for (t, s), v in by_ts.items() if v[0] >= min_n}
    out['punish'] = {f"{r['band']}|{r['tc']}|{r['opp_error']}": [int(r['n']), float(r['p_bestish(<2)']), float(r['p_no_error(<5)'])]
                     for r in read_csv(os.path.join(tdir, 'punish.csv')) if int(r['n']) >= min_n}
    out['conversion'] = {f"{r['band']}|{r['tc']}": [int(r['n']), float(r['p_keeps_over_80'])]
                         for r in read_csv(os.path.join(tdir, 'conversion.csv')) if int(r['n']) >= min_n}
    out['mate_conversion'] = {f"{r['tc']}|{r['mate_in']}": [int(r['n']), float(r['p_still_mate']), float(r['p_still_over_80'])]
                              for r in read_csv(os.path.join(tdir, 'mate_conversion.csv')) if int(r['n']) >= min_n}
    out['tc_clock'] = {f"{r['tc']}|{r['clock_frac_mid']}": [int(float(r['n'])), float(r['p_inacc+']), float(r['p_mistake+']), float(r['p_blunder'])]
                       for r in read_csv(os.path.join(tdir, 'rates_tc_clock.csv')) if float(r['n']) >= min_n}
    out['_layout'] = {'type_mix_*': '[n_errors, p per type_order]', 'punish': '[n, p_bestish(<2% lost), p_no_error(<5%)]',
                      'conversion': '[n, p win% stays > 80]', 'mate_conversion': '[n, p still forced mate, p still > 80]',
                      'tc_clock': '[n, p inaccuracy+, p mistake+, p blunder]'}
    return out


def short(path):
    return '/'.join(os.path.abspath(path).split(os.sep)[-2:])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--agg', required=True, help='aggregate.py output directory (training month)')
    ap.add_argument('--cells', default='cells_strict.csv', help='which cells file inside --agg to fit')
    ap.add_argument('--holdout', default='', help='aggregate.py output directory of the hold-out month')
    ap.add_argument('--out', required=True, help='path of humanize-model.json to write')
    ap.add_argument('--min-n', type=int, default=200, help='table entries with fewer observations are left out')
    args = ap.parse_args()

    rows = load_cells(os.path.join(args.agg, args.cells))
    if not rows:
        sys.exit(f'fit: no usable cells in {args.agg}/{args.cells}')
    X = design(rows)
    n = np.array([r['n'] for r in rows])
    model = {'version': 1, 'created': datetime.date.today().isoformat(),
             # the last two path parts only: this JSON ships in the extension, no local paths in it
             'source': {'agg': short(args.agg), 'cells': args.cells,
                        'moves': int(n.sum()), 'cells_used': len(rows)},
             'features': list(FEATURES),
             'feature_defs': {'r': f'(band_mid - {R_CENTER:g}) / {R_SCALE:g}; band_mid = band + 100 (400 -> 500, 2800 -> 2900)',
                              'L': 'log2((base + 40 * inc) / 300)', 'mid/end': 'Divider phase of the position moved from',
                              'w0..w4': "mover win% before <20 / 20-40 / 60-80 / >80 (40-60 baseline)",
                              'c': 'log2(clock left / base), at the clock bin midpoint', 'r2,rL,c2,cL': 'products'},
             'clock_bins': {'edges': list(sc.CLOCK_EDGES), 'mid': list(sc.CLOCK_MID)},
             'thresholds': {}}
    report = []
    for name, col in THRESHOLDS:
        y = np.array([r[col] for r in rows])
        beta, ses, iters = irls(X, y, n)
        dev = deviance(X, beta, y, n)
        p0 = y.sum() / n.sum()
        null_dev = deviance(X[:, :1], np.array([math.log(p0 / (1 - p0))]), y, n) if 0 < p0 < 1 else float('nan')
        pred = 1 / (1 + np.exp(-(X @ beta)))
        model['thresholds'][name] = {
            'coef': {f: round(float(b), 5) for f, b in zip(FEATURES, beta)},
            'se': {f: round(float(s), 5) for f, s in zip(FEATURES, ses)},
            'base_rate': round(float(p0), 5), 'deviance_explained': round(1 - dev / null_dev, 4) if null_dev else None}
        report.append(f'{name}: base rate {p0:.4f}, {iters} IRLS iterations, deviance explained '
                      f'{(1 - dev / null_dev) if null_dev else float("nan"):.3f}')
        report.append('  ' + ', '.join(f'{f} {b:+.3f}+/-{s:.3f}' for f, b, s in zip(FEATURES, beta, ses)))
        # A coefficient running off to +-10 or beyond is separation, not an effect: e.g. a mover below
        # 20% win cannot lose 20 points, so w0 has no blunders at all and its MLE is -infinity.
        # The consumer should read it as "rate 0 here".
        sep = [f for f, b in zip(FEATURES, beta) if abs(b) > 10]
        if sep:
            model['thresholds'][name]['separated'] = sep
            report.append(f'  separated (structural zero, read as rate 0): {", ".join(sep)}')
        insample = compare(rows, pred, col, args.min_n)
        report.append('  in-sample margins: ' + '; '.join(f'{k} {v["within_2se"]:.0%} within 2 SE (chi2/dof {v["chi2_per_dof"]:.2f}, {v["margins"]})'
                                                          for k, v in insample.items()))
        if args.holdout:
            hrows = load_cells(os.path.join(args.holdout, args.cells))
            if hrows:
                hp = 1 / (1 + np.exp(-(design(hrows) @ beta)))
                ho = compare(hrows, hp, col, args.min_n)
                model['thresholds'][name]['holdout'] = {k: {kk: (round(vv, 4) if isinstance(vv, float) else vv)
                                                            for kk, vv in v.items()} for k, v in ho.items()}
                report.append('  HOLD-OUT margins: ' + '; '.join(
                    f'{k} {v["within_2se"]:.0%} within 2 SE (chi2/dof {v["chi2_per_dof"]:.2f}, {v["margins"]})' for k, v in ho.items()))
                for k, v in ho.items():
                    for w in v['worst'][:1]:
                        report.append(f'    worst {k} {"/".join(w["key"])}: obs {w["obs"]:.4f} pred {w["pred"]:.4f} n={w["n"]:,} z={w["z"]}')
    model.update(tables_for_json(args.agg, args.min_n))
    if args.holdout:
        model['source']['holdout'] = short(args.holdout)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(model, f, separators=(',', ':'))
    report.append(f'wrote {args.out} ({os.path.getsize(args.out):,} bytes)')
    text = '\n'.join(report)
    with open(os.path.splitext(args.out)[0] + '.report.txt', 'w') as f:
        f.write(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
