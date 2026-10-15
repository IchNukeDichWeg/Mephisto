"""Shared definitions for the Stage C humanize study (extract / accounts / aggregate / fit).

Everything that decides what a study number MEANS lives here once, so the four tools cannot drift
apart, and so the classes match the extension's own: the win% formula and the 5/10/20 drop bands
are ported from src/scripts/classify-core.js, the phase divider from
src/options/pages/review/review-core.js (gamePhases / phaseOf, itself a port of scalachess
Divider.scala). If either JS file is retuned, this file has to follow in the same change, or the
study's "blunder" stops being the panel's "blunder".
"""
import math
import sys
import time

# ---- classify-core.js, ported -------------------------------------------------------------------

MATE_CP = 100000          # mate scores sit far outside any real eval, as in classify-core.js


def is_mate_score(cp):
    return abs(cp) > MATE_CP - 1000


def win_percent(cp):
    """classify-core.js winPercent: lichess's WinPercent.scala, cp clamped to +-2000, mate = 0/100."""
    if is_mate_score(cp):
        return 100.0 if cp > 0 else 0.0
    c = -2000 if cp < -2000 else (2000 if cp > 2000 else cp)
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * c)) - 1)


# win% LOST bands, classify-core.js:21. Same numbers, same meaning as the panel and Game Review.
BLUNDER, MISTAKE, INACCURACY, GOOD = 20, 10, 5, 2

PIECE_VAL = {1: 1, 2: 3, 3: 3, 4: 5, 5: 9, 6: 0}   # chess.PAWN..KING -> classify-core PIECE_VAL


def severity(drop):
    """0 none, 1 inaccuracy, 2 mistake, 3 blunder: the drop bands alone (what P(error >= c) uses)."""
    if drop >= BLUNDER:
        return 3
    if drop >= MISTAKE:
        return 2
    if drop >= INACCURACY:
        return 1
    return 0


def panel_class(win_before, win_after, forced):
    """The panel's classify() restricted to what a PGN can tell: no book, no rank, no second line,
    so brilliant/great/best/excellent/good collapse to '-'. Codes: '-' ok, 'f' forced, 'i' inaccuracy,
    'm' mistake, 'b' blunder, 'x' miss (a won position let go, which the panel shows INSTEAD of the
    drop class, classify-core.js:107)."""
    lost = max(0.0, win_before - win_after)
    if forced:
        return 'f'
    if win_before >= 75 and win_after < 55 and lost >= INACCURACY:
        return 'x'
    if lost >= BLUNDER:
        return 'b'
    if lost >= MISTAKE:
        return 'm'
    if lost >= INACCURACY:
        return 'i'
    return '-'


ERROR_CLASSES = ('i', 'm', 'b', 'x')

# ---- review-core.js gamePhases, ported --------------------------------------------------------

PHASE_MIXEDNESS_THRESHOLD = 150
PHASE_MIDGAME_PIECES = 10
PHASE_ENDGAME_PIECES = 6


def phase_region_score(y, white, black):
    """score(y, white, black), verbatim from review-core.js phaseRegionScore / Divider.scala."""
    if white == 0:
        if black == 1:
            return 1 + y
        if black == 2:
            return 2 + (6 - y) if y < 6 else 0
        if black in (3, 4):
            return 3 + (7 - y) if y < 7 else 0
        return 0
    if white == 1:
        if black == 0:
            return 1 + (8 - y)
        if black == 1:
            return 5 + abs(4 - y)
        if black == 2:
            return 4 + (7 - y)
        if black == 3:
            return 5 + (7 - y)
        return 0
    if white == 2:
        if black == 0:
            return 2 + (y - 2) if y > 2 else 0
        if black == 1:
            return 4 + (y - 1)
        if black == 2:
            return 7
        return 0
    if white == 3:
        if black == 0:
            return 3 + (y - 1) if y > 1 else 0
        if black == 1:
            return 5 + (y - 1)
        return 0
    if white == 4:
        return (3 + (y - 1) if y > 1 else 0) if black == 0 else 0
    return 0


# The 49 2x2 regions as bitboard masks with their 1-based y. review-core's grid[file][rank] has
# rank index 0 = rank 1, so region (rx, ry) covers files rx..rx+1, ranks ry..ry+1, y = ry + 1.
_REGIONS = []
for _ry in range(7):
    for _rx in range(7):
        _m = 0
        for _dx in (0, 1):
            for _dy in (0, 1):
                _m |= 1 << ((_ry + _dy) * 8 + (_rx + _dx))
        _REGIONS.append((_m, _ry + 1))
_RANK1 = 0xFF
_RANK8 = 0xFF << 56
# score lookup, so the hot loop is one dict probe per region instead of the switch
_SCORE = {(y, w, b): phase_region_score(y, w, b) for y in range(1, 8) for w in range(5) for b in range(5)}


def phase_metrics(occ_w, occ_b, majors_minors, need_mixedness=True):
    """phaseMetrics() from occupancy bitboards. Mixedness is skipped once the midgame marker is
    found: it only feeds the midgame test, and it is the expensive part (49 regions a position)."""
    backrank_sparse = (occ_w & _RANK1).bit_count() < 4 or (occ_b & _RANK8).bit_count() < 4
    mixedness = 0
    if need_mixedness:
        for m, y in _REGIONS:
            mixedness += _SCORE[(y, (occ_w & m).bit_count(), (occ_b & m).bit_count())]
    return majors_minors, backrank_sparse, mixedness


def game_phases(metrics):
    """gamePhases(): metrics is a list of (majorsMinors, backrankSparse, mixedness), index = ply
    position (0 = start). Returns (mid, end), either possibly None."""
    mid = end = None
    for i, (mm, sparse, mixed) in enumerate(metrics):
        if mid is None and (mm <= PHASE_MIDGAME_PIECES or sparse or mixed > PHASE_MIXEDNESS_THRESHOLD):
            mid = i
        if mid is not None and end is None and mm <= PHASE_ENDGAME_PIECES:
            end = i
    if mid is not None and end is not None and not (mid < end):
        mid = None
    return mid, end


def phase_of(ply, mid, end):
    """phaseOf(): the phase of the position the move at `ply` was played from."""
    if end is not None and ply >= end:
        return 'e'
    if mid is not None and ply >= mid:
        return 'm'
    return 'o'


# ---- study keys (humanize-redesign.md, Stage C "What to measure") -------------------------------

def tc_class(base, inc):
    """lichess Speed: estimated duration base + 40 * increment. Bounds from lila Speed.scala; the
    doc's 4 classes plus UltraBullet, which lichess keeps separate and which would otherwise sit
    inside bullet as its most error-prone corner."""
    est = base + 40 * inc
    if est < 30:
        return 'ultrabullet'
    if est < 180:
        return 'bullet'
    if est < 480:
        return 'blitz'
    if est < 1500:
        return 'rapid'
    if est < 21600:
        return 'classical'
    return 'correspondence'


TC_ORDER = ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical')


def rating_band(elo):
    """200-point bands 600-2800 as the doc asks, with everything under 600 in one band (400) and
    everything from 2800 up in one band (2800): too few players out there for finer cells."""
    b = (int(elo) // 200) * 200
    return 400 if b < 600 else (2800 if b > 2800 else b)


BANDS = tuple(range(400, 2801, 200))


def win_bin(cp_before):
    """Mover's win% before, binned <20, 20-40, 40-60, 60-80, >80; mate on the board is its own bin
    (M+ mover mates, M- mover is mated) because a win% of 100 hides whether it is mate in 1 or 30."""
    if is_mate_score(cp_before):
        return 'M+' if cp_before > 0 else 'M-'
    w = win_percent(cp_before)
    return '0' if w < 20 else '1' if w < 40 else '2' if w < 60 else '3' if w < 80 else '4'


WIN_BINS = ('0', '1', '2', '3', '4')
WIN_BIN_MID = {'0': 10, '1': 30, '2': 50, '3': 70, '4': 90}

# clock left as a fraction of the mover's base. Finer at the bottom, where the doc's question
# ("rapid with 1 min left > rapid with 7 min left") lives.
CLOCK_EDGES = (0.05, 0.10, 0.20, 0.35, 0.50, 0.75, 1.0)
CLOCK_MID = (0.025, 0.075, 0.15, 0.275, 0.425, 0.625, 0.875, 1.0)


def clock_bin(frac):
    if frac is None:
        return -1
    for i, e in enumerate(CLOCK_EDGES):
        if frac < e:
            return i
    return len(CLOCK_EDGES)


def duration_bucket(est):
    """Half-octave bucket of the estimated duration, so the fit gets log(duration) finer than the
    5 TC classes without one cell per TimeControl string. Returns the bucket's log2 midpoint * 2."""
    return int(round(2 * math.log2(max(est, 1))))


def mate_bucket(n):
    n = abs(int(n))
    return '1' if n <= 1 else '2' if n == 2 else '3' if n == 3 else '4-6' if n <= 6 else '7+'


MATE_BUCKETS = ('1', '2', '3', '4-6', '7+')


def opp_error_bucket(drop):
    """Size of the opponent's previous error, in win% lost, on the panel's bands."""
    if drop is None:
        return 'none'
    return ('<2' if drop < GOOD else '2-5' if drop < INACCURACY else '5-10' if drop < MISTAKE
            else '10-20' if drop < BLUNDER else '20+')


OPP_BUCKETS = ('<2', '2-5', '5-10', '10-20', '20+')

SCRAMBLE_SECONDS = 10     # doc: "time-scramble: any of the above with under 10 s on the clock"

# ---- progress --------------------------------------------------------------------------------


def fmt_dur(s):
    if s is None or s != s or s == float('inf'):
        return '--:--:--'
    s = int(max(0, s))
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return (f'{d}d ' if d else '') + f'{h}:{m:02d}:{s:02d}'


class Progress:
    """One status line: stage, count, % (when the total is known), rate, elapsed, ETA. A TTY gets a
    \\r line every 0.5 s; a pipe or file gets one plain line every `plain_every` seconds, never
    nothing (a silent run looks exactly like a hung one)."""

    def __init__(self, stage, total=None, unit='items', plain_every=30.0, stream=None):
        self.stage, self.total, self.unit = stage, total, unit
        self.stream = stream or sys.stderr
        self.tty = self.stream.isatty()
        self.t0 = time.time()
        self.last = 0.0
        self.every = 0.5 if self.tty else plain_every
        self.width = 0

    def line(self, count, extra='', frac=None, eta=None):
        el = time.time() - self.t0
        rate = count / el if el > 0 else 0.0
        if frac is None and self.total:
            frac = min(1.0, count / self.total)
        if eta is None and frac and frac > 0:
            eta = el * (1 - frac) / frac
        pct = f' {100 * frac:5.1f}%' if frac is not None else ''
        tot = f'/{self.total:,}' if self.total else ''
        s = (f'[{self.stage}]{pct} {count:,}{tot} {self.unit} | {rate:,.1f}/s | '
             f'elapsed {fmt_dur(el)} | ETA {fmt_dur(eta) if (frac is not None or eta is not None) else "n/a"}')
        return s + (' | ' + extra if extra else '')

    def update(self, count, extra='', frac=None, eta=None, force=False):
        now = time.time()
        if not force and now - self.last < self.every:
            return
        self.last = now
        s = self.line(count, extra, frac, eta)
        if self.tty:
            pad = max(0, self.width - len(s))
            self.stream.write('\r' + s + ' ' * pad)
            self.width = len(s)
        else:
            self.stream.write(s + '\n')
        self.stream.flush()

    def done(self, count, extra='', frac=None):
        self.update(count, extra, frac=frac, eta=0, force=True)
        if self.tty:
            self.stream.write('\n')
            self.stream.flush()
