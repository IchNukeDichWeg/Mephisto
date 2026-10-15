"""How HIDDEN an error is, players against Humanize: does the move still look fine to a shallow
search, and is the punishment an obvious capture or check?

usage: python3 tools/humanize-study/hidden_study.py --pgn <games_blitz.pgn> --run <run dir> --accounts <accounts.tsv>
           [--sim <sim-human --out json>] [--band 1400] [--n 1500] [--workers 9] [--depths 2,4,6] [--deep 12]

Players: errors (inaccuracy or worse) inside the guards' envelope (no mate, at most 600cp, not from +3,
as sim_types.py --envelope), strict accounts, one rating band, sampled. The move text comes from
fetch_pgn.py. Ours: every graded error in a sim-human.mjs run. For each error, Stockfish (native,
1 thread per worker) gives:
  - at each shallow depth, the win% the played move loses against that depth's best move
    (two searches: the best move, then the played one with searchmoves) -- a loss under 2% means the
    error looked fine at that depth, the miss a person makes;
  - at --deep, the opponent's best reply after it, and whether that reply is a capture or a check.
Prints the shares per severity side by side. Fixed depth, so the worker count cannot move a result.
"""
import argparse, csv, gzip, io, json, os, random, re, sys, time, collections
import multiprocessing as mp
import chess, chess.engine, chess.pgn
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import study_core as sc

def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pgn'); ap.add_argument('--run'); ap.add_argument('--accounts')
    ap.add_argument('--sim', default=None); ap.add_argument('--band', type=int, default=1400)
    ap.add_argument('--n', type=int, default=1500); ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--depths', default='2,4,6'); ap.add_argument('--deep', type=int, default=12)
    ap.add_argument('--sf', default='stockfish'); ap.add_argument('--seed', type=int, default=1)
    return ap.parse_args()
a = None; DEPTHS = []


def cp_of(score, white):
    s = score.pov(chess.WHITE if white else chess.BLACK)
    return s.score(mate_score=sc.MATE_CP)


def players():
    verd = {}
    for line in open(a.accounts):
        p = line.rstrip('\n').split('\t')
        if len(p) == 3: verd[p[0]] = p[1]
    want = {}
    with gzip.open(os.path.join(a.run, 'moves.csv.gz'), 'rt') as f:
        hdr = f.readline().rstrip('\n').split(','); ix = {c: i for i, c in enumerate(hdr)}
        for line in f:
            r = line.rstrip('\n').split(',')
            if r[ix['tc']] != 'blitz' or r[ix['dr']] == '' or r[ix['cls']] not in ('i', 'm', 'b'): continue
            if sc.rating_band(int(r[ix['elo']])) != a.band: continue
            cb, ca = int(r[ix['cb']]), int(r[ix['ca']])
            if (sc.is_mate_score(ca) and ca < 0) or (sc.is_mate_score(cb) and cb > 0) or cb - ca > 600 or (cb >= 300 and not sc.is_mate_score(cb)):
                continue
            ty, tv = r[ix['ty']], r[ix['tv']]
            kind = ('hung' if float(tv) < 3 else 'hung3+') if ty == 'hung' else 'mfree' if ty == 'mfree' else 'quiet' if ty in ('quiet', 'tactic') else ty
            want[(r[0], int(r[ix['p']]))] = (sc.severity(float(r[ix['dr']])), kind)
    games = collections.defaultdict(list)
    for (g, p), sev in want.items(): games[g].append((p, sev))
    out = []
    with open(a.pgn) as f:
        while True:
            gm = chess.pgn.read_game(f)
            if gm is None: break
            gid = gm.headers.get('GameId') or gm.headers.get('Site', '')[-8:]
            if gid not in games: continue
            if verd.get(gm.headers.get('White')) != 'ok' or verd.get(gm.headers.get('Black')) != 'ok': continue
            plies = {p: sev for p, sev in games[gid]}
            b = gm.board()
            for i, mv in enumerate(gm.mainline_moves()):   # moves.csv p is the 0-based ply (p 1 is Black's first move)
                if i in plies: out.append((b.fen(), mv.uci(), plies[i][0], plies[i][1]))
                b.push(mv)
    return out


def ours():
    d = json.load(open(a.sim)); out = []
    for g in d['results']:
        b = chess.Board(); evw = g['evw']
        for i, u in enumerate(g['moves']):
            white = b.turn
            if g['graded'][i] and i + 1 < len(evw) and evw[i] is not None and evw[i + 1] is not None:
                cb = evw[i] if white else -evw[i]; ca = evw[i + 1] if white else -evw[i + 1]
                sev = sc.severity(max(0.0, sc.win_percent(cb) - sc.win_percent(ca)))
                if sev: out.append((b.fen(), u, sev, None))
            b.push(chess.Move.from_uci(u))
    return out


eng = None
def init(args):
    # spawn start method: a worker re-imports this file without running main, so the settings
    # come in through the initializer
    global eng, a, DEPTHS
    a = args; DEPTHS = [int(x) for x in a.depths.split(',')]
    import signal; signal.signal(signal.SIGINT, signal.SIG_IGN)
    eng = chess.engine.SimpleEngine.popen_uci(a.sf); eng.configure({'Threads': 1, 'Hash': 16})


def probe(job):
    fen, uci, sev, kind = job
    b = chess.Board(fen); white = b.turn; mv = chess.Move.from_uci(uci)
    res = {'sev': sev, 'kind': kind, 'shallow': {}}
    for d in DEPTHS:
        best = eng.analyse(b, chess.engine.Limit(depth=d), game=object())
        played = eng.analyse(b, chess.engine.Limit(depth=d), root_moves=[mv], game=object())
        res['shallow'][d] = max(0.0, sc.win_percent(cp_of(best['score'], white)) - sc.win_percent(cp_of(played['score'], white)))
    b.push(mv)
    if b.is_game_over(): res['forcing'] = None; return res
    info = eng.analyse(b, chess.engine.Limit(depth=a.deep), game=object())
    rep = info.get('pv', [None])[0]
    res['forcing'] = None if rep is None else bool(b.is_capture(rep) or b.gives_check(rep))
    return res


def run(jobs, label):
    out, t0, tty = [], time.time(), sys.stderr.isatty()
    with mp.Pool(a.workers, initializer=init, initargs=(a,)) as pool:
        for i, r in enumerate(pool.imap_unordered(probe, jobs), 1):
            out.append(r)
            if i % 25 == 0 or i == len(jobs):
                el = time.time() - t0; rate = i / el
                msg = f"{label} {i}/{len(jobs)} ({100 * i / len(jobs):.0f}%) {rate:.1f}/s elapsed {el:.0f}s ETA {(len(jobs) - i) / rate:.0f}s"
                print(('\r' + msg) if tty else msg, end='' if tty else '\n', file=sys.stderr, flush=True)
    if tty: print(file=sys.stderr)
    return out


def summary(rs):
    by = collections.defaultdict(list)
    for r in rs: by[r['sev']].append(r)
    s = {}
    for sev, L in by.items():
        row = {'n': len(L)}
        for d in DEPTHS: row[f'd{d}'] = sum(1 for r in L if r['shallow'][d] < 2) / len(L)
        f = [r['forcing'] for r in L if r['forcing'] is not None]
        row['quiet_refute'] = (sum(1 for x in f if not x) / len(f)) if f else 0
        d0 = DEPTHS[0]   # the hidden share inside each kind, at the first depth (players only: ours carry no kind)
        for k in ('hung', 'mfree', 'quiet'):
            K = [r for r in L if r['kind'] == k]
            row[f'{k}_n'] = len(K); row[f'{k}_hidden'] = (sum(1 for r in K if r['shallow'][d0] < 2) / len(K)) if K else None
        s[sev] = row
    return s


if __name__ == '__main__':
    a = parse_args(); DEPTHS = [int(x) for x in a.depths.split(',')]
    rnd = random.Random(a.seed)
    P = players(); rnd.shuffle(P); P = P[:a.n]
    print(f"players: {len(P)} errors sampled (band {a.band}, blitz, inside the envelope)", file=sys.stderr)
    res = {'players': summary(run(P, 'players'))}
    if a.sim:
        O = ours(); print(f"ours: {len(O)} errors in {a.sim}", file=sys.stderr)
        res['ours'] = summary(run(O, 'ours'))
    names = {1: 'inaccuracy', 2: 'mistake', 3: 'blunder'}
    cols = [f'd{d}' for d in DEPTHS] + ['quiet_refute']
    print('share of errors that look fine (<2% win lost) at each shallow depth, and whose punishment is not a capture or check')
    print(f"{'':12s}{'':9s}{'n':>6s} " + ' '.join(f'{c:>12s}' for c in cols))
    for sev in (1, 2, 3):
        for who in res:
            r = res[who].get(sev)
            if r: print(f"{names[sev]:12s}{who:9s}{r['n']:6d} " + ' '.join(f"{100 * r[c]:11.1f}%" for c in cols)
                        + ('  hidden by kind: ' + ', '.join(f"{k} {100 * r[k + '_hidden']:.1f}% of {r[k + '_n']}" for k in ('hung', 'mfree', 'quiet') if r[k + '_hidden'] is not None) if who == 'players' else ''))
