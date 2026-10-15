"""What KIND of errors Humanize makes, next to the players it imitates.

usage: python3 tools/humanize-study/sim_types.py <sim-human --out json> <agg dir> [--band 1400] [--tc blitz]

Replays every simulated game and labels each of our errors with the study's own error_type
(extract.py): allowed mate, missed mate, hung piece (3+ or 1-2), missed free material, allowed
tactic, quiet. Prints the mix per severity beside type_mix.csv for the band and time control.
"""
import argparse, csv, json, os, sys, collections
import chess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import study_core as sc
import extract

ap = argparse.ArgumentParser()
ap.add_argument('sim'); ap.add_argument('agg')
ap.add_argument('--band', type=int, default=None); ap.add_argument('--tc', default='blitz')
a = ap.parse_args()
d = json.load(open(a.sim))
band = a.band or sc.rating_band(d['elo'])
KEYS = ('amate', 'mmate', 'hung3+', 'hung1-2', 'mfree3+', 'mfree1-2', 'tactic', 'quiet')


def key(ty, tv):
    if ty in ('hung', 'mfree'):
        return f"{ty}{'3+' if float(tv) >= 3 else '1-2'}"
    return ty


ours = collections.defaultdict(collections.Counter)
for g in d['results']:
    moves = [chess.Move.from_uci(u) for u in g['moves']]
    evw = g['evw']
    n = len(moves)
    evals = [evw[i + 1] if i + 1 < len(evw) else None for i in range(n)]   # after move i, white view
    board = chess.Board()
    drops = [None] * n
    for i in range(n):
        white = board.turn
        if g['graded'][i] and evals[i] is not None and i < len(evw):
            cb, ca = extract.mover_cp(evw[i], white), extract.mover_cp(evals[i], white)
            drop = max(0.0, sc.win_percent(cb) - sc.win_percent(ca))
            drops[i] = drop
            sev = sc.severity(drop)
            if sev:
                ty, tv, _ = extract.error_type(board, i, moves, cb, ca, drops, evals, n, white)
                ours[sev][key(ty, tv)] += 1
        board.push(moves[i])

human = {}
for r in csv.DictReader(open(os.path.join(a.agg, 'type_mix.csv'))):
    if int(r['band']) == band and r['tc'] == a.tc:
        human[int(r['severity'])] = {k: float(r['p_' + k]) for k in KEYS}
names = {1: 'inaccuracy', 2: 'mistake', 3: 'blunder'}
print(f"error types, ours ({d['mode']} at {d['elo']}, guards {'on' if d['guards'] else 'off'}) vs players {band} {a.tc}")
for sev in (1, 2, 3):
    c = ours[sev]; n = sum(c.values())
    print(f"\n{names[sev]}: {n} of ours")
    for k in KEYS:
        print(f"  {k:9s} {100 * c[k] / n if n else 0:5.1f}%   players {100 * human.get(sev, {}).get(k, 0):5.1f}%")
