"""Do people simplify when winning? Players against Humanize, in positions the mover leads by +3 or more.

usage: python3 tools/humanize-study/simplify_study.py --pgn <games_blitz.pgn> --run <run dir> --accounts <accounts.tsv>
           [--sim <sim-human --out json>] [--band 1400] [--n 4000] [--workers 9] [--depth 10]

A move SIMPLIFIES when it captures a piece (knight or more) in an even exchange: the capture's static
exchange nets 0 or more and the opponent can take back, so pieces come off. Positions: the mover is
+3.00 to +10.00 by the study's eval (players) or the sim's (ours), not a mate, standard blitz, strict
accounts. For each position Stockfish (depth --depth, one thread per worker) also says whether its own
best move simplifies, so the comparison separates "trades the engine would make anyway" from trades
chosen over a better non-trade. Fixed depth, so the worker count cannot move a result.
"""
import argparse, csv, gzip, json, os, random, sys, time, collections
import multiprocessing as mp
import chess, chess.engine, chess.pgn
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import study_core as sc
import extract

LO, HI = 300, 1000


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pgn'); ap.add_argument('--run'); ap.add_argument('--accounts')
    ap.add_argument('--sim', default=None); ap.add_argument('--band', type=int, default=1400)
    ap.add_argument('--n', type=int, default=4000); ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--depth', type=int, default=10); ap.add_argument('--sf', default='stockfish')
    ap.add_argument('--seed', type=int, default=1)
    return ap.parse_args()


def simplifies(board, mv):
    if not board.is_capture(mv) or board.is_en_passant(mv): return False
    cap = board.piece_type_at(mv.to_square)
    if not cap or extract.VAL[cap] < 3: return False
    if extract.see(board, mv) < 0: return False
    b = board.copy(); b.push(mv)
    return any(r.to_square == mv.to_square for r in b.legal_moves if b.is_capture(r))


def players(a):
    verd = {}
    for line in open(a.accounts):
        p = line.rstrip('\n').split('\t')
        if len(p) == 3: verd[p[0]] = p[1]
    want = collections.defaultdict(set)
    with gzip.open(os.path.join(a.run, 'moves.csv.gz'), 'rt') as f:
        hdr = f.readline().rstrip('\n').split(','); ix = {c: i for i, c in enumerate(hdr)}
        for line in f:
            r = line.rstrip('\n').split(',')
            if r[ix['tc']] != 'blitz' or r[ix['cb']] == '': continue
            if sc.rating_band(int(r[ix['elo']])) != a.band: continue
            cb = int(r[ix['cb']])
            if LO <= cb <= HI: want[r[0]].add(int(r[ix['p']]))
    out = []
    with open(a.pgn) as f:
        while True:
            gm = chess.pgn.read_game(f)
            if gm is None: break
            gid = gm.headers.get('GameId') or gm.headers.get('Site', '')[-8:]
            if gid not in want: continue
            if verd.get(gm.headers.get('White')) != 'ok' or verd.get(gm.headers.get('Black')) != 'ok': continue
            b = gm.board()
            for i, mv in enumerate(gm.mainline_moves()):   # moves.csv p is the 0-based ply
                if i in want[gid]: out.append((b.fen(), mv.uci()))
                b.push(mv)
    return out


def ours(a):
    d = json.load(open(a.sim)); out = []
    for g in d['results']:
        b = chess.Board(); evw = g['evw']
        for i, u in enumerate(g['moves']):
            if g['graded'][i] and i < len(evw) and evw[i] is not None:
                cb = evw[i] if b.turn else -evw[i]
                if LO <= cb <= HI: out.append((b.fen(), u))
            b.push(chess.Move.from_uci(u))
    return out


eng = None; DEPTH = 10
def init(sf, depth):
    global eng, DEPTH
    import signal; signal.signal(signal.SIGINT, signal.SIG_IGN)
    DEPTH = depth
    eng = chess.engine.SimpleEngine.popen_uci(sf); eng.configure({'Threads': 1, 'Hash': 16})


def probe(job):
    fen, uci = job
    b = chess.Board(fen)
    best = eng.play(b, chess.engine.Limit(depth=DEPTH), game=object()).move
    any_simplify = any(simplifies(b, m) for m in b.legal_moves)
    return {'played': simplifies(b, chess.Move.from_uci(uci)), 'best': bool(best) and simplifies(b, best),
            'same': best is not None and best.uci() == uci, 'avail': any_simplify}


def run(a, jobs, label):
    out, t0, tty = [], time.time(), sys.stderr.isatty()
    with mp.Pool(a.workers, initializer=init, initargs=(a.sf, a.depth)) as pool:
        for i, r in enumerate(pool.imap_unordered(probe, jobs), 1):
            out.append(r)
            if i % 50 == 0 or i == len(jobs):
                el = time.time() - t0; rate = i / el
                msg = f"{label} {i}/{len(jobs)} ({100 * i / len(jobs):.0f}%) {rate:.1f}/s elapsed {el:.0f}s ETA {(len(jobs) - i) / rate:.0f}s"
                print(('\r' + msg) if tty else msg, end='' if tty else '\n', file=sys.stderr, flush=True)
    if tty: print(file=sys.stderr)
    return out


def show(who, rs):
    av = [r for r in rs if r['avail']]
    nb = [r for r in av if not r['best']]
    f = lambda L, k: 100 * sum(1 for r in L if r[k]) / len(L) if L else 0
    print(f"{who:8s} positions {len(rs):5d}  trade available {100 * len(av) / len(rs):5.1f}%  played a trade {f(av, 'played'):5.1f}%"
          f"  engine's best is a trade {f(av, 'best'):5.1f}%  traded where the engine would not {f(nb, 'played'):5.1f}% (of {len(nb)})"
          f"  played the engine's move {f(rs, 'same'):5.1f}%")


if __name__ == '__main__':
    a = parse_args()
    P = players(a); random.Random(a.seed).shuffle(P); P = P[:a.n]
    print(f"players: {len(P)} positions at +3 to +10 (band {a.band}, blitz)", file=sys.stderr)
    rows = [('players', run(a, P, 'players'))]
    if a.sim:
        O = ours(a); rows.append(('ours', run(a, O, 'ours')))
    print("winning by +3 to +10, the mover's move; 'trade' = an even capture of a knight or more that can be taken back")
    for who, rs in rows: show(who, rs)
