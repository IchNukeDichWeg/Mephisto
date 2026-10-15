"""Fetch the move text of the study's kept games from lichess, for the per-move studies the CSV rows
cannot answer (what kind of move a player chose, not just how much it lost).

usage: python3 tools/humanize-study/fetch_pgn.py <run dir> <accounts.tsv> [--tc blitz] [--out games.pgn]

Strict accounts only, the run's kept games, one time control. Uses lichess's public export-by-ids
endpoint, 300 games per request, one request at a time; on a 429 it waits a full minute as lichess
asks. Resumable: ids already in the output file are skipped.
"""
import argparse, csv, gzip, os, re, sys, time, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument('run'); ap.add_argument('accounts'); ap.add_argument('--tc', default='blitz')
ap.add_argument('--out', default=None)
a = ap.parse_args()
out = a.out or os.path.join(a.run, f'games_{a.tc}.pgn')
verd = {}
for line in open(a.accounts):
    p = line.rstrip('\n').split('\t')
    if len(p) == 3: verd[p[0]] = p[1]
keep = set(open(os.path.join(a.run, 'keep.txt')).read().split())
ids = []
with gzip.open(os.path.join(a.run, 'games.csv.gz'), 'rt') as f:
    for row in csv.DictReader(f):
        if row['g'] in keep and row['tc'] == a.tc and verd.get(row['white']) == 'ok' and verd.get(row['black']) == 'ok':
            ids.append(row['g'])
have = set(re.findall(r'\[Site "https://lichess\.org/(\w{8})"\]', open(out).read())) if os.path.exists(out) else set()
todo = [i for i in ids if i not in have]
print(f"{len(ids):,} games, {len(have):,} already fetched, {len(todo):,} to go", flush=True)
t0, done, tty = time.time(), 0, sys.stdout.isatty()
with open(out, 'a') as fo:
    i = 0
    while i < len(todo):
        batch = todo[i:i + 300]
        req = urllib.request.Request('https://lichess.org/api/games/export/_ids?moves=true&clocks=true&evals=true&tags=true',
                                     data=','.join(batch).encode(), headers={'Accept': 'application/x-chess-pgn'})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                fo.write(r.read().decode('utf-8', 'replace')); fo.flush()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print('\n429: waiting 60 s', flush=True); time.sleep(60); continue
            raise
        i += len(batch); done += len(batch)
        el = time.time() - t0; rate = done / el
        msg = f"{done:,}/{len(todo):,} ({100 * done / len(todo):.0f}%), {rate:.0f} games/s, {el:.0f}s elapsed, ETA {(len(todo) - done) / rate:.0f}s"
        print(('\r' + msg) if tty else msg, end='' if tty else '\n', flush=True)
print('\ndone ->', out)
