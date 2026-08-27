#!/usr/bin/env python3
# Chrome Native Messaging host for a NATIVE UCI engine -- the "Remote Engine" without a server.
#
# Chrome launches this on stdin/stdout when the extension calls
# chrome.runtime.connectNative('com.<slug>.host'); there is NO listening port and nothing to
# start by hand. One source file serves several engines: install.sh copies it to
# <slug>-host.py (e.g. sf18-native-host.py) and writes the engine's absolute path into a
# sibling <slug>.path file. Optional sibling <slug>.nnue-dir points at a directory of
# Fairy-Stockfish variant nets (EvalFile is switched per UCI_Variant).
#
# Threads/Hash: the host opens with a full-power DEFAULT (all CPU cores, 2048 MB) so it's strong
# even before the extension configures it -- but the extension's Threads/Hash sliders DO override
# these (a native engine isn't sandboxed, so the sliders control it just like the WASM engines).
import sys, os, glob, struct, json, threading, traceback, datetime

_DIR = os.path.dirname(os.path.abspath(__file__))
_SLUG = os.path.basename(os.path.abspath(sys.argv[0] if sys.argv else __file__))
_SLUG = _SLUG[:-len('-host.py')] if _SLUG.endswith('-host.py') else _SLUG

# host defaults -- the whole point of running native (change here, in the open, if ever needed)
FULL_THREADS = os.cpu_count() or 8
FULL_HASH_MB = 2048

_LOG = os.path.join(_DIR, 'host-debug.log')
def _dbg(m):
    try:
        with open(_LOG, 'a') as f:
            f.write(f"{datetime.datetime.now().isoformat()} pid={os.getpid()} [{_SLUG}] {m}\n")
    except Exception:
        pass
_dbg(f"START py={sys.executable} argv={sys.argv}")

try:
    import chess.engine, chess.variant
    from chess.engine import MANAGED_OPTIONS
except Exception:
    _dbg("IMPORT FAILED:\n" + traceback.format_exc())
    raise

def _read_sibling(name):
    p = os.path.join(_DIR, name)
    if os.path.isfile(p):
        return open(p).read().strip() or None
    return None

def _resolve_engine():
    path = _read_sibling(f'{_SLUG}.path')
    if path and os.path.isfile(path):
        return path
    _dbg(f"no usable {_SLUG}.path ({path!r}); giving up")
    raise SystemExit(f"{_SLUG}: engine path missing -- re-run install.sh")

_NNUE_DIR = _read_sibling(f'{_SLUG}.nnue-dir')

# --- native messaging framing (4-byte LE length prefix + UTF-8 JSON) --------- #
_stdout_lock = threading.Lock()
def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack('<I', raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode('utf-8'))

def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    with _stdout_lock:
        sys.stdout.buffer.write(struct.pack('<I', len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

# --- response formatting (kept identical to remote-engine.py) --------------- #
def format_line(line, terminal, bestmove, in_check=False):
    if line.get('pv'):
        pv = list(map(str, line.get('pv')))
        score_prefix = 'mate' if line.get('score').is_mate() else 'cp'
        formatted = {
            'depth': line.get('depth'), 'seldepth': line.get('seldepth'),
            'multipv': line.get('multipv'), 'nodes': line.get('nodes'),
            'nps': line.get('nps'), 'hashfull': line.get('hashfull'),
            'tbhits': line.get('tbhits'), 'time': line.get('time'),
            'move': pv[0], 'pv': pv,
            'rawScore': f"{score_prefix} {line.get('score').relative}",
        }
        score = line.get('score').white()
        if line.get('score').is_mate():
            formatted['mate'] = score.mate()
        else:
            formatted['score'] = score.score()
        # an aspiration re-search: shown, but never certified against (see on_native_info)
        if line.get('lowerbound') or line.get('upperbound'):
            formatted['bound'] = True
        wdl = line.get('wdl')  # present only when the engine declares UCI_ShowWDL
        if wdl is not None:
            try:
                w = wdl.white()  # -> Wdl(wins, draws, losses) from White's perspective, permille
                formatted['wdl'] = [w.wins, w.draws, w.losses]  # [white, draw, black]
            except Exception:
                pass  # unexpected wdl shape (old python-chess) -- just omit it, never crash analyse
        return formatted
    if terminal:
        score = line.get('score')
        if score is not None and score.is_mate():
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': f'mate {score.relative}', 'mate': score.white().mate()}
        if score is None and in_check:
            # a mated position gets NO info lines (score None); without this the popup falls
            # into the cp branch and shows "Stalemate!"/"Draw" for a checkmate
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': 'mate 0', 'mate': 0}
        return {'move': '(none)', 'depth': line.get('depth', 0),
                'rawScore': f'cp {score.relative if score is not None else 0}',
                'score': score.white().score() if score is not None else 0}
    if bestmove is not None and bestmove != chess.Move.null():
        return {'move': bestmove.uci(), 'depth': line.get('depth', 0),
                'pv': [bestmove.uci()], 'rawScore': 'cp 0', 'score': 0}
    return {'move': '(none)', 'depth': line.get('depth', 0), 'rawScore': 'cp 0', 'score': 0}

def format_lines(lines, terminal, bestmove, in_check=False):
    lines = [format_line(l, terminal, bestmove, in_check) for l in (lines or [{}])]
    if 'pv' in lines[0]:
        pv0 = lines[0].get('pv')
        best, threat = pv0[0], pv0[1] if len(pv0) > 1 else '(none)'
        # a partial deeper iteration can change the engine's FINAL bestmove after the last
        # completed info line -- the true bestmove wins
        if bestmove is not None and bestmove != chess.Move.null() and bestmove.uci() != best:
            best, threat = bestmove.uci(), '(none)'
        return {'bestmove': best, 'threat': threat, 'lines': lines}
    return {'bestmove': '(none)', 'threat': '(none)', 'lines': lines}

# --- engine state (opened LAZILY: a `ping` availability probe must NOT launch the engine, so the
# extension can cheaply check which native engines are installed without spawning Stockfish x N) --- #
_ENGINE_PATH = _resolve_engine()  # cheap: reads the sibling .path, validates it exists
engine = None
_engine_init_lock = threading.Lock()
engine_options = {}
engine_lock = threading.Lock()
request_lock = threading.Lock()
request_counter = 0
# The analysis a search is streaming from, so a NEWER request can cut it short. Superseding used to
# be noticed only on the old search's next `info` frame -- and at depth those are hundreds of ms
# apart, all of it spent with the panel's progress bar on screen and no move under it. MEASURED with
# one analyse superseded mid-search (1 thread, SF18, 8s budget): first frame of the new position
# after 443 / 220 / 645ms. Stopping the old search instead makes the wait the engine's own stop
# latency. Best effort: an engine that ignores `stop` still ends on its own time limit, and the
# request_counter check below is what actually decides whose result is used.
current_analysis = None

def _set_if_declared(key, value):
    try:
        if key in engine.options:
            engine.configure({key: value})
    except Exception as e:
        _dbg(f"couldn't set {key}={value}: {e}")

def get_engine():
    global engine
    if engine is not None:
        return engine
    with _engine_init_lock:
        if engine is None:
            _dbg(f"opening engine: {_ENGINE_PATH}")
            engine = chess.engine.SimpleEngine.popen_uci(_ENGINE_PATH)
            # full-power default; the extension's configure (Threads/Hash sliders) overrides this
            _set_if_declared('Threads', FULL_THREADS)
            _set_if_declared('Hash', FULL_HASH_MB)
            _set_if_declared('UCI_ShowWDL', True)  # so info lines carry `wdl W D L` for the panel
            _apply_variant_net(None)
            _dbg(f"engine ready: Threads={FULL_THREADS} Hash={FULL_HASH_MB}")
    return engine

def _apply_variant_net(variant):
    # Fairy-Stockfish: each variant has its own net; standard chess uses the nn-* net.
    if not _NNUE_DIR:
        return
    prefix = 'nn' if variant in (None, 'chess', 'fischerandom') else variant
    hits = sorted(glob.glob(os.path.join(_NNUE_DIR, f'{prefix}-*.nnue')))
    if hits:
        _set_if_declared('EvalFile', hits[0])
        _set_if_declared('Use NNUE', True)
        _dbg(f"EvalFile -> {hits[0]}")

def do_analyse(data, mid):
    global request_counter, current_analysis
    get_engine()  # open on first real use (not on a ping probe)
    with request_lock:
        request_counter += 1
        request_id = request_counter
        stale = current_analysis
    # BEFORE the engine lock, which the outstanding search is holding: `stop` is the only thing that
    # can make it let go promptly. SimpleAnalysisResult.stop() hands the call to the engine's own
    # loop thread (call_soon_threadsafe) and is idempotent on a finished search.
    if stale is not None:
        try:
            stale.stop()
        except Exception:
            pass
    with engine_lock:
        variant = engine_options.get('UCI_Variant')
        if variant in (None, 'chess', 'fischerandom'):
            board = chess.Board(data['fen'],
                                chess960=(variant == 'fischerandom'
                                          or bool(engine_options.get('UCI_Chess960'))))
        else:
            board = chess.variant.find_variant(variant)(data['fen'])
        if data.get('moves'):
            for mv in data['moves'].split():
                board.push(chess.Move.from_uci(mv))
        # A DEPTH budget when the caller asks for one, time otherwise. Depth is what makes two
        # reviews of the same game comparable across machines, which a wall-clock budget can never
        # be. `time` is still sent alongside it and is used as the cap, so a caller that predates
        # this and a host that predates it both keep working unchanged.
        depth = data.get('depth')
        if isinstance(depth, int) and depth > 0:
            limit = chess.engine.Limit(depth=depth, time=data['time'] / 1000)
        else:
            limit = chess.engine.Limit(time=data['time'] / 1000)
        try:
            multipv = int(engine_options.get('MultiPV', 1))
        except (TypeError, ValueError):
            multipv = 1
        if 'multipv' not in engine.options:
            multipv = 1
        else:
            # Humanize asks for MultiPV 20; some engines declare a smaller max (python-chess
            # rejects an out-of-range value: "expected value for option 'MultiPV' to be at
            # most N"). Clamp to what this engine actually accepts.
            opt = engine.options['MultiPV']
            if opt.max is not None:
                multipv = min(multipv, opt.max)
            if opt.min is not None:
                multipv = max(multipv, opt.min)
        terminal = not any(board.legal_moves)  # game-over is a property of the POSITION
        in_check = board.is_check()            # terminal + in_check = checkmate, not stalemate
        with engine.analysis(board, limit, multipv=multipv) as analysis:
            with request_lock:
                current_analysis = analysis
            bestmove = None
            if request_counter == request_id:
                for info in analysis:
                    if request_counter != request_id:
                        break  # superseded by a newer position
                    # STREAM per-depth updates (live depth UI + JS premove certification).
                    # Aspiration re-searches (`lowerbound`/`upperbound`) carry an unresolved pv, so
                    # they must not feed premove certification -- but they are FORWARDED anyway,
                    # flagged, and the popup skips only the certification. Dropping them outright was
                    # worse: during a long search those windows are frequent, and with nothing sent
                    # the panel had no depth/eval/nps updates at all and sat on its progress bar.
                    if info.get('pv') and info.get('score') is not None:
                        try:
                            send_message({'id': mid, 'info': format_line(info, False, None)})
                        except Exception:
                            pass
                if request_counter == request_id:
                    bestmove = analysis.wait().move
        with request_lock:
            if current_analysis is analysis:   # only OUR own search; a newer one owns the slot now
                current_analysis = None
        return format_lines(analysis.multipv, terminal, bestmove, in_check)

def do_configure(data):
    get_engine()  # a configure is a real use -> open the engine (a ping never gets here)
    with engine_lock:
        for key, value in (data.get('options') or {}).items():
            engine_options[key] = value
            if key == 'UCI_Variant':
                _apply_variant_net(value if value != 'chess' else None)
            if key.lower() in MANAGED_OPTIONS:
                continue
            if key not in engine.options:
                continue
            try:
                engine.configure({key: value})
            except Exception as e:
                _dbg(f"configure {key}={value} failed: {e}")
        return {'ok': True}

# --- Syzygy tablebases, probed DIRECTLY (python-chess), no engine involved ------------------- #
# The extension's local-tablebase feature: the service worker sends the user's folder path and a
# FEN; the answer mimics the lichess tablebase API's shape ({category, dtz, moves:[...]}) so the
# panel's existing consumer needs no second parser. Any missing table -- a 6-man position over a
# 3-4-5 set, a half-copied folder -- raises here and returns an error, which is the worker's cue
# to fall back to the online endpoint for that position. Castling rights are refused loudly:
# Syzygy cannot represent them, and a silent wrong answer would outrank the engine's real move.
_tb_cache = {}     # folder path -> open_tablebase handle (kept for the host's lifetime)
_TB_CATEGORY = {2: 'win', 1: 'cursed-win', 0: 'draw', -1: 'blessed-loss', -2: 'loss'}

def _tb_open(path):
    if not path or not os.path.isdir(path):
        raise ValueError('tablebase folder not found')
    if path not in _tb_cache:
        import chess.syzygy
        _tb_cache[path] = chess.syzygy.open_tablebase(path)
    return _tb_cache[path]

def do_tbinfo(data):
    path = data.get('path') or ''
    if not path or not os.path.isdir(path):
        return {'error': 'folder not found'}
    men = {}
    for f in os.listdir(path):
        if f.endswith('.rtbw'):
            n = len(f[:-5].replace('v', ''))
            men[n] = men.get(n, 0) + 1
    return {'men': men, 'tables': sum(men.values())}

def do_tbprobe(data):
    import chess as _c
    import chess.syzygy as _s
    fen = data.get('fen') or ''
    board = _c.Board(fen)
    if board.castling_rights:
        return {'error': 'castling rights: syzygy cannot represent them'}
    if not board.is_valid():
        return {'error': 'illegal position'}
    tb = _tb_open(data.get('path'))
    try:
        wdl = tb.probe_wdl(board)      # side-to-move relative, like the lichess API
        dtz = tb.probe_dtz(board)
        moves = []
        for mv in board.legal_moves:
            san = board.san(mv)
            zeroing = board.is_zeroing(mv)
            board.push(mv)
            # each move's verdict is from the perspective of the side to move AFTER it, exactly
            # like the lichess API (the panel picks moves[0] on that convention: a move to 'loss'
            # loses FOR THEM, i.e. what we want) -- so NO negation here
            child_dtz = tb.probe_dtz(board)
            child_wdl = tb.probe_wdl(board)
            mate = board.is_checkmate()
            stale = board.is_stalemate()
            board.pop()
            moves.append({'uci': mv.uci(), 'san': san,
                          'category': _TB_CATEGORY.get(child_wdl, 'unknown'), 'dtz': child_dtz,
                          'checkmate': mate, 'stalemate': stale, 'zeroing': zeroing})
        # lila-tablebase's MoveInfo::sort_key: category, a mating move, a stalemating move, then
        # ZEROING preferred unless they are winning, then dtz (fastest win / longest defense).
        # Plain (rank, -dtz) shuffled a won game into a repetition draw: after a capture the child
        # dtz restarts the NEXT phase, so the capture sorted behind the check that merely kept it
        # available (found live, 2026-08-25).
        rank = {'loss': 0, 'blessed-loss': 1, 'draw': 2, 'cursed-win': 3, 'win': 4, 'unknown': 5}
        moves.sort(key=lambda m: (
            rank[m['category']],
            not m['checkmate'],
            not m['stalemate'],
            m['zeroing'] != (m['category'] not in ('win', 'cursed-win')),
            -m['dtz']))
        return {'category': _TB_CATEGORY.get(wdl, 'unknown'), 'dtz': dtz, 'moves': moves, 'source': 'local'}
    except (_s.MissingTableError, KeyError) as e:
        return {'error': f'missing table: {e}'}

def handle(msg):
    mid = msg.get('id')
    try:
        if msg.get('cmd') == 'ping':
            send_message({'id': mid, 'ok': True})  # host is installed & alive; does NOT open the engine
        elif msg.get('cmd') == 'analyse':
            send_message({'id': mid, **do_analyse(msg, mid), 'done': True})
        elif msg.get('cmd') == 'configure':
            send_message({'id': mid, **do_configure(msg)})
        elif msg.get('cmd') == 'tbprobe':
            send_message({'id': mid, **do_tbprobe(msg)})   # no engine opened: a pure file probe
        elif msg.get('cmd') == 'tbinfo':
            send_message({'id': mid, **do_tbinfo(msg)})
        else:
            send_message({'id': mid, 'error': f"unknown cmd {msg.get('cmd')!r}"})
    except Exception as e:  # never let one bad request kill the host
        send_message({'id': mid, 'error': str(e)})

def main():
    # reader loop that never blocks on a search: each message runs on its own thread,
    # so a newer 'analyse' bumps request_counter and supersedes the old one
    while True:
        msg = read_message()
        if msg is None:
            break  # Chrome closed the port
        threading.Thread(target=handle, args=(msg,), daemon=True).start()
    try:
        engine.quit()
    except Exception:
        pass

if __name__ == '__main__':
    main()
