#!/usr/bin/env python3
"""Stage C, step 1: stream a lichess standard monthly PGN and write per-move study rows.

Input (--input):
  -                  decompressed PGN on stdin (e.g. `curl -s URL | zstd -dc | extract.py --input -`);
                     no total is known, so progress shows bytes/games without a percentage
  path.pgn.zst       a local (possibly truncated) zstd file, decompressed through the zstd CLI
  path.pgn           a local plain PGN
  https://...zst     streamed straight from database.lichess.org (resumes a dropped connection
                     with an HTTP Range request); Content-Length gives a real % and ETA

What is kept (humanize-redesign.md, Stage C):
  * analysed games only (a `[%eval` in the movetext) for the per-move rows;
  * dropped: BOT on either side, Termination "Rules infraction" / "Abandoned" / "Unterminated",
    no clock ("-") or correspondence speed, a FEN start, unknown ratings, fewer than 10 plies;
  * a stratified uniform sample: at most --per-cell games per (game rating band, TC class), chosen
    by bottom-k hashing so the sample is spread over the WHOLE month rather than being its first
    hours (time-of-day decides who is online, so "first N" would be a different population);
  * a census: header-level facts for a uniform --census-rate sample of ALL filtered games, analysed
    or not, for aggregate.py's analysed-vs-unanalysed bias check.

Output directory (--out, must be new or empty: a re-run never overwrites an earlier sample):
  moves.csv.gz   one row per move with evals, see MOVE_COLUMNS
  games.csv.gz   one row per processed analysed game (players, ratings, TC, berserk, result)
  census.csv.gz  header-level rows of the census sample
  keep.txt       game ids in the final per-cell sample (moves/games also hold games that were
                 processed and later displaced from the bottom-k; aggregate.py reads only these)
  names.txt      distinct lowercase usernames of the kept games, for accounts.py
  summary.json   counters, rates, and whether the stream was truncated or interrupted

Ctrl-C: stops reading, drops in-flight games, and still finalizes every file above, so an
interrupted run is a valid (smaller, earlier-in-the-month) sample. It does not resume: a stream
cannot be re-entered mid-way, so a re-run needs a new --out.
"""
import argparse
import gzip
import hashlib
import heapq
import json
import multiprocessing as mp
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request

import study_core as sc

MOVE_COLUMNS = ('g', 'p', 'elo', 'oelo', 'tc', 'est', 'bz', 'ph', 'cb', 'ca', 'dr', 'od', 'cls',
                'clk', 'cf', 'sp', 'ty', 'tv', 'mo')
# g    game id                     p    ply index of this move (0 = white's first move)
# elo  mover rating                oelo opponent rating
# tc   mover's TC class (berserk-adjusted)          est  mover's estimated duration, seconds
# bz   1 if the mover berserked    ph   phase o/m/e (Divider port) of the position moved from
# cb/ca mover-POV cp before/after, mate as +-(100000 - N)
# dr   win% drop                   od   opponent's previous move's win% drop ('' if none)
# cls  panel class - f i m b x     clk  mover's clock before the move, s; cf = clk / mover base
# sp   seconds spent on the move ('' on each side's untimed first move)
# ty   error type (errors only): amate mmate hung mfree tactic quiet;  tv  its size: mate N, or
#      net material in pawns for hung/mfree;  mo  motif of the opponent's reply (fork pin skewer
#      disc), whatever the type, when the reply was itself not an error
GAME_COLUMNS = ('g', 'white', 'black', 'welo', 'belo', 'base', 'inc', 'tc', 'bw', 'bb', 'result',
                'term', 'plies', 'rows', 'cell', 'event')
CENSUS_COLUMNS = ('an', 'welo', 'belo', 'tc', 'result', 'term', 'plies', 'event')

DROP_TERMINATIONS = {'Rules infraction', 'Abandoned', 'Unterminated'}   # doc + never-finished games
MIN_PLIES = 10
SEP = b'\n\n[Event '
RESULTS = ('1-0', '0-1', '1/2-1/2', '*')
TAG_RE = re.compile(rb'\[(\w+) "([^"]*)"\]')
CHUNK = 1 << 24

# ---- per-game analysis (runs in the workers) ----------------------------------------------------

import chess  # noqa: E402  (after the docstring; workers import this module)

TOK_RE = re.compile(r'\{([^}]*)\}|(\S+)')
EVAL_RE = re.compile(r'\[%eval\s+(#?)(-?[\d.]+)')
CLK_RE = re.compile(r'\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]')
MOVENUM_RE = re.compile(r'^\d+\.+')
VAL = sc.PIECE_VAL
KING_VAL = 100           # for "is the target worth more than the attacker": the king outranks all
SLIDER_DIRS = {chess.BISHOP: ((1, 1), (1, -1), (-1, 1), (-1, -1)),
               chess.ROOK: ((1, 0), (-1, 0), (0, 1), (0, -1))}
SLIDER_DIRS[chess.QUEEN] = SLIDER_DIRS[chess.BISHOP] + SLIDER_DIRS[chess.ROOK]


def see(board, move):
    """Net material (pawns) the side to move wins by capture `move`, then the cheapest-attacker swap
    on that square with each side free to stop. classify-core.js sacrificesMaterial, ported: legal
    captures only, cheapest first, 8 plies max, walked from the back. One deliberate difference:
    en passant gains its pawn here, where the JS reads the empty target square as 0 (checked against
    the JS on 26,846 moves of the 2017-04 pilot: identical except 25 cases, all en passant)."""
    to = move.to_square
    if board.is_en_passant(move):
        gain = 1
    else:
        cap = board.piece_type_at(to)
        gain = VAL[cap] if cap else 0
    board.push(move)
    pushed = 1
    on_square = VAL[board.piece_type_at(to)]      # the promoted piece if it promoted, as in the JS
    balance = []
    mask = chess.BB_SQUARES[to]
    try:
        for _ in range(8):
            best = None
            bv = 99
            for m in board.generate_legal_captures(to_mask=mask):
                v = VAL[board.piece_type_at(m.from_square)]
                if v < bv:
                    best, bv = m, v
            if best is None:
                break
            balance.append(on_square)
            board.push(best)
            pushed += 1
            on_square = bv
    finally:
        for _ in range(pushed):
            board.pop()
    value = 0
    for wins in reversed(balance):
        value = max(0, wins - value)
    return gain - value


def best_capture_see(board):
    """Largest SEE among the side to move's legal captures (0 if none wins anything)."""
    best = 0
    for m in board.generate_legal_captures():
        s = see(board, m)
        if s > best:
            best = s
    return best


def _val(pt):
    return KING_VAL if pt == chess.KING else VAL[pt]


def motif(board, reply, before_attacks):
    """What the opponent's reply `reply` (already pushed: the victim is to move) does, by a simple
    detector. Simplification, named: one-move geometry only, no check that the tactic actually
    works beyond the caller's eval confirmation; ceiling = a real tactic finder (puzzle Themes
    join). Returns 'fork', 'pin', 'skewer', 'disc' or ''."""
    victim = board.turn
    attacker = not victim
    to = reply.to_square
    p = board.piece_type_at(to)
    if p is None:
        return ''
    pv = _val(p)
    vic_occ = board.occupied_co[victim]

    def worth(sq, tv):   # a target worth attacking: more valuable than the attacker, or undefended
        return tv > pv or (VAL.get(tv, 0) >= 3 and not board.is_attacked_by(victim, sq))

    n = 0
    for sq in chess.SquareSet(board.attacks(to) & vic_occ):
        t = board.piece_type_at(sq)
        if t == chess.KING or (p != chess.KING and worth(sq, _val(t))) or \
                (p == chess.KING and not board.is_attacked_by(victim, sq)):
            n += 1
    if n >= 2:
        return 'fork'
    if p in SLIDER_DIRS:
        f0, r0 = chess.square_file(to), chess.square_rank(to)
        for df, dr in SLIDER_DIRS[p]:
            first = second = None
            f, r = f0 + df, r0 + dr
            while 0 <= f < 8 and 0 <= r < 8:
                sq = chess.square(f, r)
                if board.piece_type_at(sq):
                    if first is None:
                        first = sq
                    else:
                        second = sq
                        break
                f += df
                r += dr
            if first is None or second is None:
                continue
            if not (vic_occ >> first & 1 and vic_occ >> second & 1):
                continue
            v1, v2 = _val(board.piece_type_at(first)), _val(board.piece_type_at(second))
            if v2 > v1 and (v2 > pv or v2 == KING_VAL):
                return 'pin'
            if v1 > v2 and (v1 > pv or v1 == KING_VAL) and worth(second, v2):
                return 'skewer'
    for sq in chess.SquareSet(board.pieces_mask(chess.BISHOP, attacker) | board.pieces_mask(chess.ROOK, attacker)
                              | board.pieces_mask(chess.QUEEN, attacker)):
        if sq == to:
            continue
        newly = board.attacks(sq) & ~before_attacks.get(sq, 0) & vic_occ
        if not newly:
            continue
        sv = _val(board.piece_type_at(sq))
        for t_sq in chess.SquareSet(newly):
            t = board.piece_type_at(t_sq)
            tv = _val(t)
            if t == chess.KING or tv > sv or (VAL[t] >= 3 and not board.is_attacked_by(victim, t_sq)):
                return 'disc'
    return ''


def slider_attacks(board, color):
    return {sq: board.attacks(sq) for sq in chess.SquareSet(
        board.pieces_mask(chess.BISHOP, color) | board.pieces_mask(chess.ROOK, color)
        | board.pieces_mask(chess.QUEEN, color))}


def parse_tags(text):
    end = text.find('\n\n')
    return dict(re.findall(r'\[(\w+) "([^"]*)"\]', text[:end if end >= 0 else len(text)])), end


def parse_tc(tc):
    """'180+2' -> (180, 2); '-' or junk -> None."""
    try:
        b, i = tc.split('+')
        return int(b), int(i)
    except (ValueError, AttributeError):
        return None


def mover_cp(ev, white):
    return ev if white else -ev


def analyse_game(gid, text):
    """One analysed game -> ('ok', gid, game_row, rows_text, nrows) or ('drop', gid, reason)."""
    tags, end = parse_tags(text)
    if end < 0:
        return ('drop', gid, 'truncated')
    tc = parse_tc(tags.get('TimeControl'))
    base, inc = tc
    sans, comments = [], []
    ended = False
    for m in TOK_RE.finditer(text, end + 2):
        c, tok = m.group(1), m.group(2)
        if c is not None:
            if sans:
                comments[-1] = (comments[-1] or '') + c
            continue
        if tok in RESULTS:
            ended = True
            break
        if tok[0] == '$':
            continue
        tok = MOVENUM_RE.sub('', tok)
        if not tok:
            continue
        sans.append(tok.rstrip('?!'))
        comments.append(None)
    if not ended:
        return ('drop', gid, 'truncated')
    n = len(sans)
    if n < MIN_PLIES:
        return ('drop', gid, 'short')

    evals, clocks = [], []
    for c in comments:
        ev = ck = None
        if c:
            em = EVAL_RE.search(c)
            if em:
                if em.group(1):
                    k = int(float(em.group(2)))
                    ev = (sc.MATE_CP - abs(k)) * (1 if k > 0 else -1) if k != 0 else 0
                else:
                    ev = int(round(float(em.group(2)) * 100))
            cm = CLK_RE.search(c)
            if cm:
                ck = int(cm.group(1)) * 3600 + int(cm.group(2)) * 60 + float(cm.group(3))
        evals.append(ev)
        clocks.append(ck)

    # pass 1: parse, and the Divider metrics of every position (index = ply, 0 = start)
    board = chess.Board()
    moves, metrics = [], []
    need_mixed = True
    try:
        for san in sans:
            mm = (board.occupied & ~board.pawns & ~board.kings).bit_count()
            met = sc.phase_metrics(board.occupied_co[chess.WHITE], board.occupied_co[chess.BLACK], mm, need_mixed)
            if need_mixed and (mm <= sc.PHASE_MIDGAME_PIECES or met[1] or met[2] > sc.PHASE_MIXEDNESS_THRESHOLD):
                need_mixed = False
            metrics.append(met)
            mv = board.parse_san(san)
            moves.append(mv)
            board.push(mv)
        mm = (board.occupied & ~board.pawns & ~board.kings).bit_count()
        metrics.append(sc.phase_metrics(board.occupied_co[chess.WHITE], board.occupied_co[chess.BLACK], mm, need_mixed))
    except ValueError:
        return ('drop', gid, 'illegal')
    final_mate = board.is_checkmate()
    final_draw = (not final_mate) and (board.is_stalemate() or board.is_insufficient_material())
    mid, endp = sc.game_phases(metrics)

    # Berserk: lichess halves the berserker's clock and drops the increment. Each side's first clock
    # shows its starting time (the first move is not timed), so half the base marks it.
    first_w = clocks[0] if n > 0 else None
    first_b = clocks[1] if n > 1 else None
    bw = int(base > 0 and first_w is not None and first_w < 0.75 * base)
    bb = int(base > 0 and first_b is not None and first_b < 0.75 * base)
    eff = {True: (base / 2, 0) if bw else (base, inc), False: (base / 2, 0) if bb else (base, inc)}
    welo, belo = int(tags['WhiteElo']), int(tags['BlackElo'])

    # pass 2: per-move rows
    board = chess.Board()
    rows = []
    drops = [None] * n
    prev_clock = {True: None, False: None}
    for i in range(n):
        mv = moves[i]
        white = board.turn
        ebase, einc = eff[white]
        clk_before = prev_clock[white] if prev_clock[white] is not None else ebase
        if i == 0:
            prev_clock[white] = clocks[i]
            board.push(mv)
            continue
        ev_b = evals[i - 1]
        ev_a = evals[i]
        if ev_a is None and i == n - 1:
            ev_a = sc.MATE_CP if final_mate and white else (-sc.MATE_CP if final_mate else (0 if final_draw else None))
        if ev_b is None or ev_a is None:
            break                       # analysis stops here (rare): no row we cannot grade
        cb, ca = mover_cp(ev_b, white), mover_cp(ev_a, white)
        wb, wa = sc.win_percent(cb), sc.win_percent(ca)
        drop = max(0.0, wb - wa)
        drops[i] = drop
        in_check = board.is_check()
        forced = False
        if in_check or drop >= sc.INACCURACY:
            # exact for every error (what the panel labels Forced); for non-errors only checked
            # positions are counted, where nearly every one-legal-move position occurs
            forced = board.legal_moves.count() == 1
        cls = sc.panel_class(wb, wa, forced)
        ty = tv = mo = ''
        if cls in sc.ERROR_CLASSES:
            ty, tv, mo = error_type(board, i, moves, cb, ca, drops, evals, n, white)
        ck = clocks[i]
        sp = ''
        if ck is not None and prev_clock[white] is not None:
            sp = f'{max(0.0, prev_clock[white] - ck + einc):.1f}'
        prev_clock[white] = ck
        cf = f'{clk_before / ebase:.3f}' if ebase > 0 and clk_before is not None else ''
        od = drops[i - 1]
        rows.append(','.join((
            gid, str(i), str(welo if white else belo), str(belo if white else welo),
            sc.tc_class(ebase, einc), str(int(ebase + 40 * einc)), str(bw if white else bb),
            sc.phase_of(i, mid, endp), str(cb), str(ca), f'{drop:.2f}',
            '' if od is None else f'{od:.2f}', cls,
            '' if clk_before is None else f'{clk_before:.1f}', cf, sp, ty, str(tv), mo)))
        board.push(mv)
    game_row = ','.join((gid, tags.get('White', '').lower(), tags.get('Black', '').lower(), str(welo), str(belo),
                         str(base), str(inc), sc.tc_class(base, inc), str(bw), str(bb), tags.get('Result', ''),
                         tags.get('Termination', '').replace(',', ' '), str(n), str(len(rows)),
                         f'{sc.rating_band((welo + belo) // 2)}|{sc.tc_class(base, inc)}',
                         'arena' if 'tournament' in tags.get('Event', '').lower() else
                         ('swiss' if 'swiss' in tags.get('Event', '').lower() else 'casual')))
    return ('ok', gid, game_row, '\n'.join(rows), len(rows))


def error_type(board, i, moves, cb, ca, drops, evals, n, white):
    """Label one error (board = position before move i, mover to move). Priority, named: allowed
    mate > missed mate > hung piece > missed free material > allowed tactic > quiet. One label per
    error so the type mix sums to 1; the motif column is kept for every error regardless."""
    mv = moves[i]
    # the opponent's reply, and whether it kept the punishment (its own drop < inaccuracy)
    reply = moves[i + 1] if i + 1 < n else None
    reply_ok = False
    if reply is not None and evals[i + 1] is not None and evals[i] is not None:
        ob = sc.win_percent(mover_cp(evals[i], not white))
        oa = sc.win_percent(mover_cp(evals[i + 1], not white))
        reply_ok = (ob - oa) < sc.INACCURACY
    mo = ''
    best_before = best_capture_see(board)
    played_see = see(board, mv) if board.is_capture(mv) else 0
    if board.is_en_passant(mv):
        captured = 1
    else:
        cpt = board.piece_type_at(mv.to_square)
        captured = VAL[cpt] if cpt else 0
    board.push(mv)
    try:
        opp_best = best_capture_see(board)
        if reply is not None and reply_ok:
            before = slider_attacks(board, board.turn)
            board.push(reply)
            try:
                mo = motif(board, reply, before)
            finally:
                board.pop()
    finally:
        board.pop()
    if sc.is_mate_score(ca) and ca < 0:
        return 'amate', sc.MATE_CP - abs(ca), mo
    if sc.is_mate_score(cb) and cb > 0 and not (sc.is_mate_score(ca) and ca > 0):
        return 'mmate', sc.MATE_CP - abs(cb), mo
    # hung: what the opponent can now win by one capture's exchange, net of what this move took
    hung = opp_best - captured
    if hung >= 1:
        return 'hung', hung, mo
    missed = best_before - max(0, played_see)
    if missed >= 1:
        return 'mfree', missed, mo
    if mo:
        return 'tactic', '', mo
    return 'quiet', '', mo


def worker_init():
    signal.signal(signal.SIGINT, signal.SIG_IGN)   # the parent owns Ctrl-C and finalizes the files


def process_batch(batch):
    out = []
    for gid, raw in batch:
        try:
            out.append(analyse_game(gid, raw.decode('utf-8', 'replace')))
        except Exception as e:  # one malformed game must not kill a multi-hour run
            out.append(('drop', gid, 'error:' + type(e).__name__))
    return out

# ---- input -----------------------------------------------------------------------------------


class Source:
    """Decompressed PGN bytes plus how far through the COMPRESSED input we are, when knowable."""

    def __init__(self, spec, max_bytes):
        self.spec, self.max_bytes = spec, max_bytes
        self.total = None          # compressed bytes expected
        self.fed = 0               # compressed bytes consumed
        self.truncated = False     # max_bytes cut the input short on purpose
        self.error = None
        self.procs = []
        if spec == '-':
            self.out = sys.stdin.buffer
            return
        if spec.startswith('http://') or spec.startswith('https://'):
            self._raw = self._http_reader(spec)
        else:
            size = os.path.getsize(spec)
            self.total = size
            if not spec.endswith('.zst'):
                if max_bytes:
                    self.total = min(size, max_bytes)
                self.out = _CountingFile(open(spec, 'rb'), self)
                return
            self._raw = self._file_reader(spec)
        if max_bytes and self.total:
            self.total = min(self.total, max_bytes)
        elif max_bytes:
            self.total = max_bytes
        zstd = shutil.which('zstd') or '/opt/homebrew/bin/zstd'
        if not os.path.exists(zstd):
            sys.exit('extract: the zstd CLI is needed to read .zst input (brew install zstd)')
        # stderr discarded: a deliberately truncated pilot makes zstd complain at the end, by design
        self.zp = subprocess.Popen([zstd, '-dc'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0)
        self.procs.append(self.zp)
        self.out = self.zp.stdout
        threading.Thread(target=self._feed, daemon=True).start()

    def _file_reader(self, path):
        with open(path, 'rb') as f:
            while True:
                b = f.read(1 << 20)
                if not b:
                    return
                yield b

    def _http_reader(self, url):
        """Stream the URL; on a dropped connection, re-request from the byte reached (Range), up to
        10 times in a row. The month is ~30 GB: one reset must not throw away an hour."""
        pos, fails = 0, 0
        while True:
            req = urllib.request.Request(url, headers={'User-Agent': 'mephisto-humanize-study/1'})
            if pos:
                req.add_header('Range', f'bytes={pos}-')
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    if self.total is None:
                        cl = r.headers.get('Content-Length')
                        self.total = int(cl) if cl else None
                        if self.max_bytes:
                            self.total = min(self.total or self.max_bytes, self.max_bytes)
                    if pos and r.status != 206:
                        raise IOError('server ignored the Range request; cannot resume mid-file')
                    while True:
                        b = r.read(1 << 20)
                        if not b:
                            return
                        pos += len(b)
                        fails = 0
                        yield b
            except (OSError, IOError) as e:
                fails += 1
                if fails > 10:
                    self.error = f'download failed 10 times in a row at byte {pos:,}: {e}'
                    return
                sys.stderr.write(f'\n[extract] download error at byte {pos:,} ({e}); resuming in {5 * fails} s\n')
                time.sleep(5 * fails)

    def _feed(self):
        try:
            for b in self._raw:
                if self.max_bytes and self.fed + len(b) >= self.max_bytes:
                    b = b[:self.max_bytes - self.fed]
                    self.zp.stdin.write(b)
                    self.fed += len(b)
                    self.truncated = True
                    break
                self.zp.stdin.write(b)
                self.fed += len(b)
        except (BrokenPipeError, ValueError, OSError):
            pass
        finally:
            try:
                self.zp.stdin.close()
            except OSError:
                pass

    def frac(self):
        if self.total:
            return min(1.0, self.fed / self.total)
        return None

    def close(self):
        for p in self.procs:
            try:
                p.kill()
            except OSError:
                pass


class _CountingFile:
    def __init__(self, f, src):
        self.f, self.src = f, src

    def read(self, n):
        if self.src.max_bytes:
            n = min(n, self.src.max_bytes - self.src.fed)
            if n <= 0:
                self.src.truncated = True
                return b''
        b = self.f.read(n)
        self.src.fed += len(b)
        return b


def iter_games(stream, stats):
    """Split decompressed PGN into games on the blank line before `[Event `. Yields each game
    WITHOUT its leading '[Event ' (put back by the caller for the few games it keeps). A last piece
    without a result token is a cut-off game (truncated pilot stream) and is counted, not parsed."""
    buf = b''
    first = True
    while True:
        chunk = stream.read(CHUNK)
        if not chunk:
            break
        stats['bytes'] += len(chunk)
        buf += chunk
        if first:
            buf = buf.lstrip()
            if buf.startswith(b'[Event '):
                buf = buf[7:]
            first = False
        parts = buf.split(SEP)
        buf = parts.pop()
        yield from parts
    tail = buf.rstrip()
    if tail:
        if tail.endswith((b'1-0', b'0-1', b'1/2-1/2', b'*')) and b'\n\n' in tail:
            yield tail
        else:
            stats['truncated_tail'] += 1

# ---- main ------------------------------------------------------------------------------------


def header_filter(tags):
    """Header-only filters. Returns (reason or None, base, inc, welo, belo)."""
    if tags.get(b'WhiteTitle') == b'BOT' or tags.get(b'BlackTitle') == b'BOT':
        return 'bot', 0, 0, 0, 0
    if tags.get(b'Termination', b'').decode('utf-8', 'replace') in DROP_TERMINATIONS:
        return 'termination', 0, 0, 0, 0
    if b'FEN' in tags or tags.get(b'Variant', b'Standard') not in (b'Standard',):
        return 'variant', 0, 0, 0, 0
    tc = parse_tc(tags.get(b'TimeControl', b'-').decode())
    if tc is None or sc.tc_class(*tc) == 'correspondence':
        return 'no_clock', 0, 0, 0, 0
    try:
        welo, belo = int(tags[b'WhiteElo']), int(tags[b'BlackElo'])
    except (KeyError, ValueError):
        return 'no_rating', 0, 0, 0, 0
    return None, tc[0], tc[1], welo, belo


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', required=True, help="'-' (decompressed PGN on stdin), a .pgn/.pgn.zst path, or a URL")
    ap.add_argument('--out', required=True, help='output directory (created; must be empty)')
    ap.add_argument('--workers', type=int, default=0, help='worker processes, 0 = all cores')
    # 5,000 is the bottom of the doc's 5,000-10,000 range: enough for a 1-in-1,000 blunder cell
    # (about 3,000 games for 10% relative error), and it halves the account checks, which at the
    # API's 120,000 users/day are the slowest step of the whole study.
    ap.add_argument('--per-cell', type=int, default=5000,
                    help='max analysed games per (game rating band, TC class) cell, uniform over the month '
                         '(bottom-k hash); 0 = no cap. Default 5000')
    ap.add_argument('--census-rate', type=float, default=0.02,
                    help='share of ALL filtered games recorded header-only for the bias check (default 0.02)')
    ap.add_argument('--max-bytes', type=int, default=0, help='stop after this many COMPRESSED input bytes (pilots)')
    ap.add_argument('--max-games', type=int, default=0, help='stop after this many games seen (pilots)')
    ap.add_argument('--seed', type=int, default=1, help='sample seed: bottom-k hash key and census RNG')
    ap.add_argument('--batch', type=int, default=64, help='games per worker task')
    args = ap.parse_args()

    if os.path.exists(args.out) and os.listdir(args.out):
        sys.exit(f'extract: {args.out} is not empty; pick a new --out (a re-run never overwrites a sample)')
    os.makedirs(args.out, exist_ok=True)
    workers = args.workers or os.cpu_count()

    stats = {'bytes': 0, 'games': 0, 'analysed': 0, 'truncated_tail': 0, 'dispatched': 0,
             'skipped_by_cap': 0, 'processed_ok': 0, 'rows': 0, 'census': 0}
    drops = {}
    rng = random.Random(args.seed)
    key = args.seed.to_bytes(8, 'little')
    heaps = {}            # cell -> max-heap of (-hash, gid, white, black): the bottom-k sample
    ok = set()
    t0 = time.time()

    src = Source(args.input, args.max_bytes)
    fm = gzip.open(os.path.join(args.out, 'moves.csv.gz'), 'wt', compresslevel=3)
    fg = gzip.open(os.path.join(args.out, 'games.csv.gz'), 'wt', compresslevel=3)
    fc = gzip.open(os.path.join(args.out, 'census.csv.gz'), 'wt', compresslevel=3)
    fm.write(','.join(MOVE_COLUMNS) + '\n')
    fg.write(','.join(GAME_COLUMNS) + '\n')
    fc.write(','.join(CENSUS_COLUMNS) + '\n')

    # Backpressure: Pool.imap_unordered drains its input generator as fast as it can, so without a
    # bound the reader (GB/s) would queue the whole month in RAM ahead of the workers.
    inflight = threading.BoundedSemaphore(4 * workers)
    stop = threading.Event()
    prog = sc.Progress('extract', unit='games')

    def status(force=False, done=False):
        el = time.time() - t0
        fr = src.frac()
        extra = (f'{stats["bytes"] / 1e9:.2f} GB pgn' + (f' ({src.fed / 1e9:.2f}/{src.total / 1e9:.2f} GB zst)' if src.total else '')
                 + f' | analysed {stats["analysed"]:,} | processed {stats["processed_ok"]:,} ({stats["processed_ok"] / max(el, 1e-9):,.1f}/s)'
                 + f' | rows {stats["rows"]:,} | cells {len(heaps)}')
        if done:
            prog.done(stats['games'], extra, frac=fr)
        else:
            prog.update(stats['games'], extra, frac=fr, force=force)

    def batches():
        batch = []
        for part in iter_games(src.out, stats):
            if stop.is_set():
                break
            stats['games'] += 1
            if not stats['games'] & 4095:
                status()        # also while the cap skips everything, so a late-month stretch is not silent
            if args.max_games and stats['games'] > args.max_games:
                stats['games'] -= 1
                src.truncated = True
                break
            analysed = b'%eval' in part
            census = rng.random() < args.census_rate
            if not analysed and not census:
                continue
            tagend = part.find(b'\n\n')
            if tagend < 0:
                continue
            tags = dict(TAG_RE.findall(part[:tagend]))
            reason, base, inc, welo, belo = header_filter(tags)
            if reason:
                if analysed:
                    drops[reason] = drops.get(reason, 0) + 1
                continue
            plies = part.count(b'{') if b'%clk' in part else -1     # every move has a clock comment
            if census:
                if plies >= MIN_PLIES or plies < 0:
                    ev = tags.get(b'Event', b'').lower()
                    fc.write(f'{int(analysed)},{welo},{belo},{sc.tc_class(base, inc)},{tags.get(b"Result", b"").decode()},'
                             f'{tags.get(b"Termination", b"").decode("utf-8", "replace").replace(",", " ")},{plies},'
                             f'{"arena" if b"tournament" in ev else ("swiss" if b"swiss" in ev else "casual")}\n')
                    stats['census'] += 1
            if not analysed:
                continue
            stats['analysed'] += 1
            gid = tags.get(b'Site', b'').rsplit(b'/', 1)[-1].decode('ascii', 'replace')
            if not gid:
                continue
            cell = f'{sc.rating_band((welo + belo) // 2)}|{sc.tc_class(base, inc)}'
            h = int.from_bytes(hashlib.blake2b(gid.encode(), digest_size=8, key=key).digest(), 'little')
            heap = heaps.setdefault(cell, [])
            if args.per_cell and len(heap) >= args.per_cell:
                if h >= -heap[0][0]:
                    stats['skipped_by_cap'] += 1
                    continue
                heapq.heapreplace(heap, (-h, gid, tags.get(b'White', b'').decode('utf-8', 'replace').lower(),
                                         tags.get(b'Black', b'').decode('utf-8', 'replace').lower()))
            else:
                heapq.heappush(heap, (-h, gid, tags.get(b'White', b'').decode('utf-8', 'replace').lower(),
                                      tags.get(b'Black', b'').decode('utf-8', 'replace').lower()))
            batch.append((gid, b'[Event ' + part))
            stats['dispatched'] += 1
            if len(batch) >= args.batch:
                if not acquire():
                    return
                yield batch
                batch = []
        if batch and acquire():
            yield batch

    def acquire():
        # polled, so a Ctrl-C can stop this feeder thread instead of leaving it blocked forever
        while not inflight.acquire(timeout=0.5):
            if stop.is_set():
                return False
        return not stop.is_set()

    interrupted = False
    pool = mp.get_context('spawn').Pool(workers, initializer=worker_init)
    try:
        for res in pool.imap_unordered(process_batch, batches()):
            inflight.release()
            for r in res:
                if r[0] == 'ok':
                    _, gid, grow, rtext, nrows = r
                    fg.write(grow + '\n')
                    if nrows:
                        fm.write(rtext + '\n')
                    stats['rows'] += nrows
                    stats['processed_ok'] += 1
                    ok.add(gid)
                else:
                    drops[r[2]] = drops.get(r[2], 0) + 1
            status()
        pool.close()
    except KeyboardInterrupt:
        interrupted = True
        stop.set()
        sys.stderr.write('\n[extract] Ctrl-C: stopping, dropping in-flight games, finalizing the files...\n')
        pool.terminate()
    finally:
        if not interrupted:
            pool.join()
        src.close()

    keep, names = [], set()
    per_cell = {}
    for cell, heap in heaps.items():
        for _, gid, w, b in heap:
            if gid in ok:
                keep.append(gid)
                names.add(w)
                names.add(b)
                per_cell[cell] = per_cell.get(cell, 0) + 1
    names.discard('')
    for f in (fm, fg, fc):
        f.close()
    with open(os.path.join(args.out, 'keep.txt'), 'w') as f:
        f.write('\n'.join(sorted(keep)) + ('\n' if keep else ''))
    with open(os.path.join(args.out, 'names.txt'), 'w') as f:
        f.write('\n'.join(sorted(names)) + ('\n' if names else ''))
    el = time.time() - t0
    status(done=True)
    summary = dict(stats, drops=drops, kept=len(keep), names=len(names), per_cell=dict(sorted(per_cell.items())),
                   elapsed_s=round(el, 1), games_per_s=round(stats['games'] / max(el, 1e-9), 1),
                   processed_per_s=round(stats['processed_ok'] / max(el, 1e-9), 2),
                   rows_per_s=round(stats['rows'] / max(el, 1e-9), 1),
                   compressed_bytes=src.fed, compressed_total=src.total,
                   input_truncated=bool(src.truncated or stats['truncated_tail']), interrupted=interrupted,
                   download_error=src.error, workers=workers, args=vars(args))
    with open(os.path.join(args.out, 'summary.json'), 'w') as f:
        json.dump(summary, f, indent=1)
    print(f'extract: {stats["games"]:,} games read, {stats["analysed"]:,} analysed, {stats["processed_ok"]:,} processed, '
          f'{len(keep):,} kept in {len(per_cell)} cells, {len(names):,} names, {stats["rows"]:,} rows, '
          f'{el:.1f} s ({summary["processed_per_s"]} games/s, {summary["rows_per_s"]} moves/s)'
          + (' [INTERRUPTED: partial sample]' if interrupted else '')
          + (' [input truncated]' if summary['input_truncated'] else '')
          + (f' [DOWNLOAD FAILED: {src.error}]' if src.error else ''))
    if interrupted:
        sys.exit(130)


if __name__ == '__main__':
    main()
