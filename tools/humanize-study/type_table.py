"""The players' error-type mix per rating band, for Humanize's type-aware pick (HZ_TYPE_MIX in popup.js).

usage: python3 tools/humanize-study/type_table.py <run dir> <accounts.tsv> [--tc blitz]

Inside the guards' envelope only (never into or past a mate, at most 600cp, not from +3 up, the same
filter as sim_types.py --envelope), strict accounts only. A hung minor piece or more is left out:
the hang guard refuses those, so the pick can only choose among the rest. Per band and severity
(inaccuracy, mistake, blunder) prints the shares of [hung pawns, missed free material, quiet], where
quiet takes the 'tactic' label too (a reply motif the pick cannot see). One pass, about 15 s.
"""
import argparse, csv, gzip, os, sys, collections, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import study_core as sc

ap = argparse.ArgumentParser()
ap.add_argument('run'); ap.add_argument('accounts'); ap.add_argument('--tc', default='blitz')
a = ap.parse_args()
verd = {}
for line in open(a.accounts):
    p = line.rstrip('\n').split('\t')
    if len(p) == 3: verd[p[0]] = p[1]
keep = set(open(os.path.join(a.run, 'keep.txt')).read().split())
games = set()
with gzip.open(os.path.join(a.run, 'games.csv.gz'), 'rt') as f:
    for row in csv.DictReader(f):
        if row['g'] in keep and verd.get(row['white']) == 'ok' and verd.get(row['black']) == 'ok': games.add(row['g'])
cnt = collections.defaultdict(collections.Counter)
t0, n = time.time(), 0
tty = sys.stderr.isatty()
with gzip.open(os.path.join(a.run, 'moves.csv.gz'), 'rt') as f:
    hdr = f.readline().rstrip('\n').split(','); ix = {c: i for i, c in enumerate(hdr)}
    for line in f:
        n += 1
        if n % 500000 == 0:
            msg = f"{n:,} rows, {time.time() - t0:.0f}s"
            print(('\r' + msg) if tty else msg, end='' if tty else '\n', file=sys.stderr, flush=True)
        r = line.rstrip('\n').split(',')
        if r[0] not in games or r[ix['tc']] != a.tc or r[ix['dr']] == '' or r[ix['cls']] not in ('i', 'm', 'b'): continue
        cb, ca = int(r[ix['cb']]), int(r[ix['ca']])
        if (sc.is_mate_score(ca) and ca < 0) or (sc.is_mate_score(cb) and cb > 0) or cb - ca > 600 or (cb >= 300 and not sc.is_mate_score(cb)):
            continue
        ty, tv = r[ix['ty']], r[ix['tv']]
        if ty == 'hung': k = 'hung' if float(tv) < 3 else None
        elif ty == 'mfree': k = 'mfree'
        elif ty in ('tactic', 'quiet'): k = 'quiet'
        else: k = None
        if k: cnt[(sc.rating_band(int(r[ix['elo']])), sc.severity(float(r[ix['dr']])))][k] += 1
if tty: print(file=sys.stderr)
print(f"band  severity  n       hung   mfree  quiet   ({a.tc}, inside the envelope, hung 3+ left out)")
for band in sorted({b for b, _ in cnt}):
    row = []
    for sev in (1, 2, 3):
        c = cnt[(band, sev)]; m = sum(c.values())
        print(f"{band:<5} {sev:<9} {m:<7} {c['hung'] / m:.3f}  {c['mfree'] / m:.3f}  {c['quiet'] / m:.3f}" if m else f"{band} {sev} 0")
        row.append(f"[{c['hung'] / m:.3f},{c['mfree'] / m:.3f},{c['quiet'] / m:.3f}]" if m else 'null')
    print(f"    js  {band}: [{','.join(row)}],")
