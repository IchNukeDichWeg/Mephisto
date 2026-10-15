#!/usr/bin/env python3
"""Stage C, step 3: join extract.py's rows with accounts.py's verdicts and build the study tables.

Account filter (owner decision 5): a game is dropped when EITHER player is not `ok`, i.e. marked
tosViolation, closed (`disabled`), missing from the API's answer, or not a valid id. The bulk
endpoint shows a closed account as {id, username, disabled} with no tosViolation field (measured on
the 2017-04 pilot: 100 of 100 closed accounts), so a closed cheater cannot be told apart from a
self-closed account; that is why every closed account goes. The same tables are also built with only
the TOS marks dropped ("tosonly") so the report can say how much the closed accounts move them.

Players with no verdict yet (accounts.py still running) are handled by --unchecked: `drop` (default,
the only setting for a real result) or `keep` (pipeline smoke tests on samples nobody has checked).

Outputs in --out (all CSV, rates with their binomial standard error):
  cells_strict.csv / cells_tosonly.csv / cells_strict_rw.csv   fit.py input: counts of moves and of
      errors >= inaccuracy / mistake / blunder per (band, tc, duration bucket, phase, win bin, clock
      bin); _rw = strict reweighted to the unanalysed games' mix (see bias below)
  rates_band_tc.csv      P(error >= class) per mover band x TC, strict and tosonly side by side
  rates_tc_clock.csv     per TC x clock-fraction bin, and rates_tc_abs_clock.csv per absolute seconds
  rates_phase.csv, rates_movenum.csv, rates_winbin.csv
  type_mix.csv           P(type | error class, band, TC); type_scramble.csv (clock < 10 s split);
                         type_phase_win.csv (tc x phase x win bin x type counts, the sim's histogram)
  punish.csv             P(reply grade | opponent's previous error size, band, TC)
  conversion.csv         P(win% stays > 80 | win% before > 80, band, TC), per move
  mate_conversion.csv    P(still forced mate after the move | mate in N on the board), by N bucket
  bias.csv, weights.csv  analysed vs unanalysed mix from the census, and the reweighting factors
  report.txt             headline numbers, the strict-vs-tosonly and reweighting deltas, drop counts
"""
import argparse
import collections
import csv
import gzip
import json
import math
import os
import sys

import study_core as sc

ABS_CLOCK_EDGES = (10, 30, 60, 180, 600)
ABS_CLOCK_NAMES = ('<10', '10-30', '30-60', '60-180', '180-600', '600+')
MOVE_EDGES = (10, 20, 30, 40, 60)
MOVE_NAMES = ('1-10', '11-20', '21-30', '31-40', '41-60', '61+')


def abs_clock_bin(s):
    for e, n in zip(ABS_CLOCK_EDGES, ABS_CLOCK_NAMES):
        if s < e:
            return n
    return ABS_CLOCK_NAMES[-1]


def move_bin(m):
    for e, n in zip(MOVE_EDGES, MOVE_NAMES):
        if m <= e:
            return n
    return MOVE_NAMES[-1]


def type_key(ty, tv):
    """Hung / missed material split at a minor piece: the doc's A1 veto line (a pawn is a real human
    error, a minor or more is what the vetoes stop)."""
    if ty in ('hung', 'mfree'):
        return ty + ('3+' if tv and int(tv) >= 3 else '1-2')
    return ty


TYPES = ('amate', 'mmate', 'hung3+', 'hung1-2', 'mfree3+', 'mfree1-2', 'tactic', 'quiet')


def se(k, n):
    """Binomial SE with the variance taken at (k + 0.5) / (n + 1): a 0-of-20 cell gets an honest
    nonzero error bar instead of 0, which would make any comparison against it infinitely sure."""
    if n <= 0:
        return float('nan')
    p = (k + 0.5) / (n + 1)
    return math.sqrt(p * (1 - p) / n)


def load_verdicts(path):
    v = {}
    if path and os.path.exists(path):
        with open(path) as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) == 3:
                    v[parts[0]] = parts[1]
    return v


class Acc:
    """Weighted counters: n, and errors at severity >= 1, 2, 3 (index 1..3)."""
    __slots__ = ('n', 'e')

    def __init__(self):
        self.n = 0.0
        self.e = [0.0, 0.0, 0.0, 0.0]

    def add(self, sev, w=1.0):
        self.n += w
        for s in range(1, sev + 1):
            self.e[s] += w


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run', required=True, help='extract.py output directory')
    ap.add_argument('--state', default='', help="accounts.py state file")
    ap.add_argument('--out', required=True, help='output directory for the tables')
    ap.add_argument('--unchecked', choices=('drop', 'keep'), default='drop',
                    help='players without a verdict: drop their games (default) or keep (smoke tests only)')
    ap.add_argument('--min-n', type=int, default=30, help='rows with fewer moves are still written but flagged thin')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with open(os.path.join(args.run, 'summary.json')) as f:
        summary = json.load(f)
    keep = set(open(os.path.join(args.run, 'keep.txt')).read().split())
    verdicts = load_verdicts(args.state)

    # ---- games: account verdicts and the per-game reweighting key ----
    games = {}
    gdrop = collections.Counter()
    with gzip.open(os.path.join(args.run, 'games.csv.gz'), 'rt') as f:
        for row in csv.DictReader(f):
            g = row['g']
            if g not in keep:
                continue
            vs = [verdicts.get(row['white']), verdicts.get(row['black'])]
            if None in vs and args.unchecked == 'drop':
                gdrop['unchecked'] += 1
                continue
            vs = ['ok' if v is None else v for v in vs]
            strict = all(v == 'ok' for v in vs)
            tosonly = not any(v in ('tos', 'closed_tos') for v in vs)
            for v in set(vs):
                if v != 'ok':
                    gdrop['has_' + v] += 1
            if not strict and not tosonly:
                continue
            band = sc.rating_band((int(row['welo']) + int(row['belo'])) // 2)
            decisive = 'draw' if row['result'] == '1/2-1/2' else 'decisive'
            games[g] = (strict, tosonly, (band, row['tc'], decisive))
    n_strict = sum(1 for v in games.values() if v[0])
    n_tos = sum(1 for v in games.values() if v[1])

    # ---- bias: census mix, analysed vs unanalysed (header-level, all games, no account filter) ----
    mix = {0: collections.Counter(), 1: collections.Counter()}
    facets = collections.defaultdict(lambda: {0: collections.Counter(), 1: collections.Counter()})
    plies = {0: [0, 0], 1: [0, 0]}
    with gzip.open(os.path.join(args.run, 'census.csv.gz'), 'rt') as f:
        for row in csv.DictReader(f):
            an = int(row['an'])
            band = sc.rating_band((int(row['welo']) + int(row['belo'])) // 2)
            dec = 'draw' if row['result'] == '1/2-1/2' else 'decisive'
            mix[an][(band, row['tc'], dec)] += 1
            facets['result'][an][row['result']] += 1
            facets['termination'][an][row['term']] += 1
            facets['tc'][an][row['tc']] += 1
            facets['band'][an][str(band)] += 1
            facets['event'][an][row['event']] += 1
            if int(row['plies']) >= 0:
                plies[an][0] += int(row['plies'])
                plies[an][1] += 1
    weights = {}
    tot = {a: sum(mix[a].values()) for a in (0, 1)}
    for key in set(mix[0]) | set(mix[1]):
        pu = mix[0][key] / tot[0] if tot[0] else 0
        pa = mix[1][key] / tot[1] if tot[1] else 0
        # cells the census never saw analysed keep weight 1: no evidence either way
        weights[key] = (pu / pa) if pa > 0 and pu > 0 else 1.0
    with open(os.path.join(args.out, 'bias.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['facet', 'value', 'share_analysed', 'share_unanalysed', 'n_analysed', 'n_unanalysed'])
        for facet, d in facets.items():
            ta, tu = sum(d[1].values()), sum(d[0].values())
            for val in sorted(set(d[0]) | set(d[1])):
                w.writerow([facet, val, f'{d[1][val] / ta:.4f}' if ta else '', f'{d[0][val] / tu:.4f}' if tu else '',
                            d[1][val], d[0][val]])
        for a, name in ((1, 'analysed'), (0, 'unanalysed')):
            if plies[a][1]:
                w.writerow(['mean_plies', name, f'{plies[a][0] / plies[a][1]:.1f}', '', plies[a][1], ''])
    with open(os.path.join(args.out, 'weights.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['band', 'tc', 'result', 'weight', 'n_analysed', 'n_unanalysed'])
        for key in sorted(weights, key=str):
            w.writerow([*key, f'{weights[key]:.4f}', mix[1][key], mix[0][key]])

    # ---- moves ----
    variants = ('strict', 'tosonly', 'strict_rw')
    cells = {v: collections.defaultdict(Acc) for v in variants}
    band_tc = {v: collections.defaultdict(Acc) for v in variants}
    tc_clock = collections.defaultdict(Acc)
    tc_abs = collections.defaultdict(Acc)
    phase_t = collections.defaultdict(Acc)
    movenum = collections.defaultdict(Acc)
    winbin_t = collections.defaultdict(Acc)
    berserk_t = collections.defaultdict(Acc)
    types = collections.defaultdict(collections.Counter)
    type_scr = collections.defaultdict(collections.Counter)
    type_pw = collections.Counter()
    punish = collections.defaultdict(lambda: [0, 0, 0, 0])      # n, best-ish, no error, blunder
    conv = collections.defaultdict(lambda: [0, 0])
    mconv = collections.defaultdict(lambda: [0, 0, 0])            # n, still mate, still > 80
    used = skipped = forced = 0
    k = -1
    total_rows = summary.get('rows') or None
    prog = sc.Progress('aggregate', total=total_rows, unit='rows')
    with gzip.open(os.path.join(args.run, 'moves.csv.gz'), 'rt') as f:
        header = f.readline().rstrip('\n').split(',')
        ix = {c: i for i, c in enumerate(header)}
        I_G, I_P, I_ELO, I_TC, I_EST, I_BZ, I_PH = (ix[c] for c in ('g', 'p', 'elo', 'tc', 'est', 'bz', 'ph'))
        I_CB, I_CA, I_DR, I_OD, I_CLS, I_CLK, I_CF, I_TY, I_TV = (ix[c] for c in ('cb', 'ca', 'dr', 'od', 'cls', 'clk', 'cf', 'ty', 'tv'))
        for k, line in enumerate(f):
            if not k & 0xFFFF:
                prog.update(k, f'used {used:,}')
            r = line.rstrip('\n').split(',')
            gi = games.get(r[I_G])
            if gi is None:
                skipped += 1
                continue
            strict, tosonly, wkey = gi
            cls = r[I_CLS]
            if cls == 'f':
                forced += 1         # no choice, no error: the panel's Forced, and humanize's reflex
                continue
            used += 1
            band = sc.rating_band(int(r[I_ELO]))
            tc = r[I_TC]
            bz = r[I_BZ] == '1'
            cb, ca = int(r[I_CB]), int(r[I_CA])
            drop = float(r[I_DR])
            sev = sc.severity(drop)
            wb = sc.win_bin(cb)
            cf = float(r[I_CF]) if r[I_CF] else None
            clk = float(r[I_CLK]) if r[I_CLK] else None
            ph = r[I_PH]
            rw = weights.get(wkey, 1.0)
            if bz:
                if strict:
                    berserk_t[(band, tc)].add(sev)
                continue            # berserk is its own time control (doc); kept out of every other table
            mate_on_board = wb in ('M+', 'M-')
            if not mate_on_board and cf is not None:
                key = (band, tc, sc.duration_bucket(int(r[I_EST])), ph, wb, sc.clock_bin(cf))
                if strict:
                    cells['strict'][key].add(sev)
                    cells['strict_rw'][key].add(sev, rw)
                if tosonly:
                    cells['tosonly'][key].add(sev)
            if tosonly:
                band_tc['tosonly'][(band, tc)].add(sev)
            if not strict:
                continue
            band_tc['strict'][(band, tc)].add(sev)
            band_tc['strict_rw'][(band, tc)].add(sev, rw)
            if cf is not None:
                tc_clock[(tc, sc.clock_bin(cf))].add(sev)
            if clk is not None:
                tc_abs[(tc, abs_clock_bin(clk))].add(sev)
            phase_t[(tc, ph)].add(sev)
            movenum[(tc, move_bin(int(r[I_P]) // 2 + 1))].add(sev)
            winbin_t[(tc, wb)].add(sev)
            if sev >= 1:
                t = type_key(r[I_TY], r[I_TV])
                types[(band, tc, sev)][t] += 1
                type_scr[(tc, clk is not None and clk < sc.SCRAMBLE_SECONDS)][t] += 1
                type_pw[(tc, ph, wb, t)] += 1
            od = r[I_OD]
            if od:
                p = punish[(band, tc, sc.opp_error_bucket(float(od)))]
                p[0] += 1
                p[1] += drop < sc.GOOD
                p[2] += sev == 0
                p[3] += sev == 3
            if wb == '4':
                c = conv[(band, tc)]
                c[0] += 1
                c[1] += sc.win_percent(ca) > 80
            if wb == 'M+':
                m = mconv[(tc, sc.mate_bucket(sc.MATE_CP - cb))]
                m[0] += 1
                m[1] += sc.is_mate_score(ca) and ca > 0
                m[2] += sc.win_percent(ca) > 80
    prog.done(k + 1 if total_rows else used, f'used {used:,}')

    # ---- write ----
    def rate_cols(a):
        out = [f'{a.n:.0f}' if a.n == int(a.n) else f'{a.n:.1f}']
        for s in (1, 2, 3):
            p = a.e[s] / a.n if a.n else float('nan')
            out += [f'{p:.5f}', f'{se(a.e[s], a.n):.5f}']
        return out

    rate_hdr = ['n', 'p_inacc+', 'se_inacc+', 'p_mistake+', 'se_mistake+', 'p_blunder', 'se_blunder']

    for v in variants:
        with open(os.path.join(args.out, f'cells_{v}.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['band', 'tc', 'dbucket', 'phase', 'winbin', 'clockbin', 'n', 'e1', 'e2', 'e3'])
            for key in sorted(cells[v], key=str):
                a = cells[v][key]
                w.writerow([*key, f'{a.n:.3f}', f'{a.e[1]:.3f}', f'{a.e[2]:.3f}', f'{a.e[3]:.3f}'])

    def write_rates(name, table, keynames, keysort=str):
        with open(os.path.join(args.out, name), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(list(keynames) + rate_hdr + ['thin'])
            for key in sorted(table, key=keysort):
                a = table[key]
                w.writerow(list(key) + rate_cols(a) + [int(a.n < args.min_n)])

    tc_rank = {t: i for i, t in enumerate(sc.TC_ORDER)}
    bt_sort = lambda k: (tc_rank.get(k[1], 9), k[0])  # noqa: E731
    with open(os.path.join(args.out, 'rates_band_tc.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['band', 'tc'] + ['strict_' + h for h in rate_hdr] + ['tosonly_' + h for h in rate_hdr]
                   + ['strict_rw_p_inacc+', 'strict_rw_p_blunder'])
        for key in sorted(band_tc['strict'], key=bt_sort):
            a, b, c = band_tc['strict'][key], band_tc['tosonly'][key], band_tc['strict_rw'][key]
            w.writerow(list(key) + rate_cols(a) + rate_cols(b)
                       + [f'{c.e[1] / c.n:.5f}' if c.n else '', f'{c.e[3] / c.n:.5f}' if c.n else ''])
    write_rates('rates_tc_clock.csv', {(k[0], f'{sc.CLOCK_MID[k[1]]:.3f}' if k[1] >= 0 else 'na'): v
                                       for k, v in tc_clock.items()}, ('tc', 'clock_frac_mid'),
                lambda k: (tc_rank.get(k[0], 9), k[1]))
    write_rates('rates_tc_abs_clock.csv', tc_abs, ('tc', 'clock_s'),
                lambda k: (tc_rank.get(k[0], 9), ABS_CLOCK_NAMES.index(k[1])))
    write_rates('rates_phase.csv', phase_t, ('tc', 'phase'), lambda k: (tc_rank.get(k[0], 9), 'ome'.index(k[1])))
    write_rates('rates_movenum.csv', movenum, ('tc', 'move'), lambda k: (tc_rank.get(k[0], 9), MOVE_NAMES.index(k[1])))
    write_rates('rates_winbin.csv', winbin_t, ('tc', 'winbin'), lambda k: (tc_rank.get(k[0], 9), k[1]))
    write_rates('rates_berserk.csv', berserk_t, ('band', 'tc'), bt_sort)

    with open(os.path.join(args.out, 'type_mix.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['band', 'tc', 'severity', 'n_errors'] + ['p_' + t for t in TYPES])
        for key in sorted(types, key=lambda k: (tc_rank.get(k[1], 9), k[0], k[2])):
            c = types[key]
            n = sum(c.values())
            w.writerow(list(key) + [n] + [f'{c[t] / n:.4f}' for t in TYPES])
    with open(os.path.join(args.out, 'type_scramble.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['tc', 'clock_under_10s', 'n_errors'] + ['p_' + t for t in TYPES])
        for key in sorted(type_scr, key=lambda k: (tc_rank.get(k[0], 9), k[1])):
            c = type_scr[key]
            n = sum(c.values())
            w.writerow([key[0], int(key[1]), n] + [f'{c[t] / n:.4f}' for t in TYPES])
    with open(os.path.join(args.out, 'type_phase_win.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['tc', 'phase', 'winbin', 'type', 'count'])
        for key in sorted(type_pw, key=str):
            w.writerow(list(key) + [type_pw[key]])
    with open(os.path.join(args.out, 'punish.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['band', 'tc', 'opp_error', 'n', 'p_bestish(<2)', 'se', 'p_no_error(<5)', 'p_blunder'])
        for key in sorted(punish, key=lambda k: (tc_rank.get(k[1], 9), k[0], sc.OPP_BUCKETS.index(k[2]) if k[2] in sc.OPP_BUCKETS else 9)):
            n, b, ok, bl = punish[key]
            w.writerow(list(key) + [n, f'{b / n:.4f}', f'{se(b, n):.4f}', f'{ok / n:.4f}', f'{bl / n:.4f}'])
    with open(os.path.join(args.out, 'conversion.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['band', 'tc', 'n', 'p_keeps_over_80', 'se'])
        for key in sorted(conv, key=bt_sort):
            n, k2 = conv[key]
            w.writerow(list(key) + [n, f'{k2 / n:.4f}', f'{se(k2, n):.4f}'])
    with open(os.path.join(args.out, 'mate_conversion.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['tc', 'mate_in', 'n', 'p_still_mate', 'se', 'p_still_over_80'])
        for key in sorted(mconv, key=lambda k: (tc_rank.get(k[0], 9), sc.MATE_BUCKETS.index(k[1]))):
            n, m, k2 = mconv[key]
            w.writerow(list(key) + [n, f'{m / n:.4f}', f'{se(m, n):.4f}', f'{k2 / n:.4f}'])

    # ---- report: headline numbers and how much the choices move them ----
    lines = []
    lines.append(f'run: {os.path.abspath(args.run)}')
    lines.append(f"extract: {summary['games']:,} games read, {summary['analysed']:,} analysed, "
                 f"{summary['kept']:,} kept in {len(summary.get('per_cell', {}))} cells"
                 + (' [INTERRUPTED sample]' if summary.get('interrupted') else '')
                 + (' [truncated input]' if summary.get('input_truncated') else ''))
    lines.append(f'games: {len(keep):,} kept by extract; strict {n_strict:,}, tosonly {n_tos:,}; '
                 f'drop reasons (a game can have two): {dict(gdrop)}')
    lines.append(f'moves: {used:,} graded (forced excluded: {forced:,}; rows of non-sample games skipped: {skipped:,})')

    def overall(table):
        a = Acc()
        for x in table.values():
            a.n += x.n
            for s in (1, 2, 3):
                a.e[s] += x.e[s]
        return a

    lines.append('')
    lines.append('overall P(error >= class) per move, inaccuracy+ / mistake+ / blunder:')
    for v in variants:
        a = overall(band_tc[v])
        if a.n:
            lines.append(f'  {v:10s} n={a.n:,.0f}  ' + '  '.join(f'{a.e[s] / a.n:.4f}' for s in (1, 2, 3)))
    lines.append('')
    lines.append('strict vs tosonly (effect of ALSO dropping closed accounts), per band x TC, inaccuracy+ and blunder:')
    worst = []
    for key, a in band_tc['strict'].items():
        b = band_tc['tosonly'].get(key)
        if not b or a.n < args.min_n or b.n < args.min_n:
            continue
        for s in (1, 3):
            pa, pb = a.e[s] / a.n, b.e[s] / b.n
            z = (pa - pb) / max(se(a.e[s], a.n), 1e-9)
            worst.append((abs(z), key, s, pa, pb, z))
    worst.sort(reverse=True)
    if worst:
        within = sum(1 for x in worst if x[0] < 1) / len(worst)
        lines.append(f'  {len(worst)} band x TC x class comparisons; {100 * within:.0f}% differ by < 1 strict SE '
                     f'(the samples overlap, so this is a shift measure, not a test)')
        for az, key, s, pa, pb, z in worst[:8]:
            lines.append(f'  {key[0]:>5} {key[1]:11s} {"inacc+" if s == 1 else "blunder"}: strict {pa:.4f} vs tosonly {pb:.4f} ({z:+.1f} SE)')
    lines.append('')
    lines.append('bias (census, all filtered games, no account filter): analysed vs unanalysed share')
    for facet in ('result', 'termination', 'tc', 'event'):
        d = facets.get(facet)
        if not d:
            continue
        ta, tu = sum(d[1].values()), sum(d[0].values())
        parts = [f'{val} {d[1][val] / ta:.3f}/{d[0][val] / tu:.3f}' for val in sorted(set(d[0]) | set(d[1]))
                 if ta and tu and (d[1][val] + d[0][val]) >= 5]
        lines.append(f'  {facet}: ' + ', '.join(parts))
    for a, name in ((1, 'analysed'), (0, 'unanalysed')):
        if plies[a][1]:
            lines.append(f'  mean plies {name}: {plies[a][0] / plies[a][1]:.1f} (n={plies[a][1]:,})')
    a, b = overall(band_tc['strict']), overall(band_tc['strict_rw'])
    if a.n and b.n:
        lines.append(f'  reweighting to the unanalysed band x TC x decisive mix moves overall inaccuracy+ '
                     f'{a.e[1] / a.n:.4f} -> {b.e[1] / b.n:.4f}, blunder {a.e[3] / a.n:.4f} -> {b.e[3] / b.n:.4f}')
    lines.append('')
    lines.append('error type mix, all strict errors:')
    tot_types = collections.Counter()
    for c in types.values():
        tot_types.update(c)
    n_err = sum(tot_types.values())
    if n_err:
        lines.append('  ' + ', '.join(f'{t} {tot_types[t] / n_err:.3f}' for t in TYPES) + f'  (n={n_err:,})')
    text = '\n'.join(lines) + '\n'
    with open(os.path.join(args.out, 'report.txt'), 'w') as f:
        f.write(text)
    print(text)


if __name__ == '__main__':
    main()
