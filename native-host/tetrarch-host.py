#!/usr/bin/env python3
# Chrome Native Messaging host for Tetrarch -- the four-player engine.
#
# Chrome launches this on stdin/stdout when the extension calls
# chrome.runtime.connectNative('com.tetrarch.host'); there is NO listening port.
# Install with ./install-native.sh --tetrarch, like the other native hosts.
#
# WHY THIS DOES NOT USE python-chess, unlike every other host here:
# python-chess is a TWO-player library. Its parser is built on 64 squares and a
# `chess.Move`, so `n14` is not a square it can name, `position fen4 ...` is not
# a command it can send, and `go rtime/btime/ytime/gtime` is not a clock shape it
# models. SimpleEngine would reject Tetrarch's output before we ever saw it. So
# this host speaks the line protocol directly over a pipe -- which is also less
# machinery than the two-player hosts need, because Tetrarch is single-threaded:
# `go` runs to completion and `stop` is accepted-and-ignored (PROTOCOL.md §5), so
# there is no cancellation to model and no post-bestmove chain to harvest.
#
# Engine path resolution order:
#   1. $TETRARCH_DIR   2. a sibling file `tetrarch-path`   3. ../../../Tetrarch
import sys, os, struct, json, queue, threading, subprocess, traceback, datetime, collections

_DIR = os.path.dirname(os.path.abspath(__file__))
_LOG = os.path.join(_DIR, 'host-debug.log')
def _dbg(m):
    try:
        with open(_LOG, 'a') as f:
            f.write(f"{datetime.datetime.now().isoformat()} pid={os.getpid()} tetrarch {m}\n")
    except Exception:
        pass

def _resolve_repo():
    if os.environ.get('TETRARCH_DIR'):
        return os.environ['TETRARCH_DIR']
    sibling = os.path.join(_DIR, 'tetrarch-path')
    if os.path.isfile(sibling):
        # utf-8-sig: Notepad writes a UTF-8 BOM, which strip() keeps. Windows PowerShell 5.1's `>`
        # writes UTF-16 and Explorer's "Copy as path" adds quotes: the first killed the host at
        # import, the second pointed it at no checkout (audit 3.1.330 NATIVEA-3).
        try:
            raw = open(sibling, 'rb').read()
            text = raw.decode('utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig').strip()
        except Exception as e:
            _dbg(f"cannot read tetrarch-path: {e!r} -- save it as plain UTF-8 text")
            text = ''
        if len(text) >= 2 and text[0] == text[-1] and text[0] in '"\'':
            text = text[1:-1].strip()
        if text:
            return text
    return os.path.abspath(os.path.join(_DIR, '..', '..', 'Tetrarch'))

def _resolve_python():
    # THIS host's own interpreter first (audit 3.1.330 BOUNDARY-3): the installer pins the host's
    # shebang to the python3 on PATH, the one Tetrarch's setup.sh installs numpy into, and on Windows
    # it is the one the .bat shim chose. The fixed paths came first before, so a pyenv/conda/venv
    # Python, or python.org's beside a Homebrew one, ran uci.py under an interpreter without numpy and
    # every search ended in "Engine error". They stay as a fallback for an embedding with no
    # sys.executable; `python3` is not a command on Windows.
    for cand in (sys.executable, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'):
        if cand and os.path.isfile(cand):
            return cand
    return sys.executable or 'python3'

# WINDOWS: stdio MUST be binary. The CRT translates \n -> \r\n on a text-mode
# handle, and that byte lands inside the 4-byte length prefix as readily as in the
# JSON -- so every frame is silently corrupted rather than failing loudly. Chrome
# just reports the host as unavailable. No-op everywhere else.
if sys.platform == 'win32':
    import msvcrt
    for _f in (sys.stdin, sys.stdout):
        try:
            msvcrt.setmode(_f.fileno(), os.O_BINARY)
        except Exception:
            pass

# --- native messaging framing (4-byte LE length prefix + UTF-8 JSON) --------- #
_MAX_MESSAGE_BYTES = 8 * 1024 * 1024  # S9: a few MB is plenty for any real frame; a length this
# large only comes from a corrupt prefix (four stray bytes), and reading that many bytes off
# stdin is itself the hang -- exit cleanly (like a closed port) instead of trying.
def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack('<I', raw)[0]
    if n > _MAX_MESSAGE_BYTES:
        return None  # corrupt length prefix -- treat like Chrome closed the port
    return json.loads(sys.stdin.buffer.read(n).decode('utf-8'))

# Queued writes, never inline -- the same reason as the other hosts: a native-messaging
# write blocks once the pipe fills and Chrome is not draining, and a blocked writer
# inside the engine-reader thread would stop us consuming engine output entirely.
_send_q = queue.Queue()
def _sender_loop():
    while True:
        obj = _send_q.get()
        try:
            data = json.dumps(obj).encode('utf-8')
            sys.stdout.buffer.write(struct.pack('<I', len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except Exception:
            return  # port closed
def send_message(obj):
    _send_q.put(obj)

# --- the engine ------------------------------------------------------------- #
engine_lock = threading.Lock()   # one search at a time; Tetrarch is single-threaded
_proc = None
_repo = _resolve_repo()
_stderr_tail = collections.deque(maxlen=20)   # the running engine's last stderr lines
_stderr_drain = None

def _stderr_why():
    """The engine's last stderr lines as one capped line ('' if none). An engine that died
    (stdout closed) is reaped first and its drain finished, so its final traceback is in;
    one still running is read as it stands."""
    try:
        _proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    if _proc.poll() is not None and _stderr_drain:
        _stderr_drain.join(2)
    return ' | '.join(l.strip() for l in list(_stderr_tail) if l.strip())[-600:]

def _start_engine():
    """Launch `python3 uci.py` with cwd = the repo root. The cwd matters: the Net
    option defaults to the RELATIVE path `nets/net-v4.nnue`, so starting anywhere
    else gives an engine that boots and then cannot load its evaluation."""
    global _proc, _stderr_tail, _stderr_drain
    if _proc and _proc.poll() is None:
        return _proc
    uci = os.path.join(_repo, 'uci.py')
    if not os.path.isfile(uci):
        raise RuntimeError(f"Tetrarch not found at {_repo} -- set TETRARCH_DIR or native-host/tetrarch-path")
    # CREATE_NO_WINDOW: without it Windows pops a console for the engine on every
    # launch, in front of the game. Undefined on other platforms, hence the getattr.
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if sys.platform == 'win32' else 0
    python = _resolve_python()
    # stderr is KEPT (its last lines), not discarded: an engine that dies at start -- numpy missing, a
    # Python below Tetrarch's minimum -- said why only there, and the host reported a bare
    # "Broken pipe" on its next write (audit 3.1.330 BOUNDARY-3). Drained on a thread so a chatty
    # engine can never block on a full pipe.
    _proc = subprocess.Popen([python, uci], cwd=_repo,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1,
                             creationflags=flags)
    _stderr_tail = tail = collections.deque(maxlen=20)
    _stderr_drain = threading.Thread(target=lambda f=_proc.stderr: tail.extend(f), daemon=True)
    _stderr_drain.start()
    try:
        _send('uci')
        up = _read_until(lambda l: l.strip() == 'uciok', timeout=30)
    except OSError:
        up = None
    why = _stderr_why() if up is None else ''   # stdout closed: a dying engine is reaped first
    if up is None and _proc.poll() is None:
        _dbg("no uciok within 30 s; carrying on")   # merely slow, as before: not a dead engine
    elif up is None:
        why = why or 'no output'
        _dbg(f"engine did not start under {python}: {why}")
        raise RuntimeError(f"Tetrarch did not start under {python}: {why}")
    # A RELAUNCH (crash, kill) starts from the engine's defaults, while _OPTIONS still holds what the
    # old process was sent and do_configure skips an unchanged value -- so the panel's Mode before
    # every analyse never arrived, and a free-for-all game was searched under Teams rules with one
    # line for the rest of the host's life. Re-send everything the old process had.
    for key, value in _OPTIONS.items():
        _send(f"setoption name {key} value {_uci_value(value)}")
    _dbg(f"engine up from {_repo}")
    return _proc

def _discard_engine(why):
    """Kill an engine whose pipe can no longer be trusted, so the next request relaunches it
    (_start_engine re-sends every option). A search the host gives up on still has output on its way:
    after `info string error handling 'position'` Tetrarch reads the host's own `go` next and
    searches the OLD board to a bestmove, and a search past its deadline is still running. Left in
    the pipe, that bestmove answered the NEXT request, whose own search answered the one after, for
    the rest of the host's life (audit 3.1.331 TETRARCHHOST-1). A relaunch measured 0.05 s to uciok
    on an M5 Pro, inside the next request's own 300 ms search; nothing else resyncs the pipe, because
    Tetrarch answers `isready` at once even mid-search."""
    _dbg(f"engine discarded: {why}")
    try:
        _proc.kill()
        _proc.wait(timeout=5)
    except Exception:
        pass

def _send(line):
    _proc.stdin.write(line + '\n')
    _proc.stdin.flush()

def _read_until(pred, timeout=600, on_line=None):
    """Read engine lines until `pred(line)`. Returns the matching line, or None if
    the engine died. `on_line` sees every line first (that is how info streams)."""
    deadline = datetime.datetime.now().timestamp() + timeout
    while True:
        if _proc.poll() is not None:
            return None
        line = _proc.stdout.readline()
        if line == '':
            return None
        if on_line:
            on_line(line.rstrip('\n'))
        if pred(line):
            return line.rstrip('\n')
        if datetime.datetime.now().timestamp() > deadline:
            return None

# --- UCI info -> the frame shape the panel already consumes ----------------- #
def parse_info(line):
    """`info depth 9 score cp 363 nodes 305328 nps 1278456 time 238 pv h2h3 b8c8 ...`
    -> the same dict shape the two-player hosts emit, so the transport is identical.
    Scores are the SIDE-TO-MOVE'S TEAM (PROTOCOL.md), not White -- the panel is told
    which seat is to move separately and does not have to guess."""
    t = line.split()
    if not t or t[0] != 'info':
        return None
    out, i = {}, 1
    while i < len(t):
        k = t[i]
        if k == 'pv':
            out['pv'] = t[i + 1:]
            out['move'] = t[i + 1] if len(t) > i + 1 else None
            break
        if k == 'score' and i + 2 < len(t):
            kind, val = t[i + 1], t[i + 2]
            out['rawScore'] = f"{kind} {val}"
            try:
                out['mate' if kind == 'mate' else 'score'] = int(val)
            except ValueError:
                pass
            i += 3
            continue
        if k in ('depth', 'seldepth', 'nodes', 'nps', 'time', 'multipv', 'hashfull'):
            try:
                out[k] = int(t[i + 1])
            except (ValueError, IndexError):
                pass
            i += 2
            continue
        if k == 'string':
            return None  # `info string ...` is human-readable, not a line
        i += 1
    return out or None

# --- commands --------------------------------------------------------------- #
# Options Tetrarch declares that we let the extension set. Mode and Setup RESET THE
# BOARD when changed (PROTOCOL.md), so they are only sent when the value differs.
_OPTIONS = {}

def _uci_value(value):
    return ('true' if value else 'false') if isinstance(value, bool) else value

def do_configure(data):
    with engine_lock:
        _start_engine()
        try:
            for key, value in (data.get('options') or {}).items():
                if _OPTIONS.get(key) == value:
                    continue   # Setup/Mode reset the board -- never re-send an unchanged value
                _OPTIONS[key] = value
                _send(f"setoption name {key} value {_uci_value(value)}")
            _send('isready')
            ready = _read_until(lambda l: l.strip() == 'readyok', timeout=30)
        except OSError:
            ready = None   # the pipe broke: the engine is gone
        if ready is None:
            # An engine that died here answered {'ok': True} all the same, so the caller went on as if
            # its options were set (audit 3.1.330 follow-up L43). Say so, with its own words; the next
            # analyse relaunches it and re-sends every option. One merely slow to answer isready
            # carries on, as at startup.
            why = _stderr_why()
            if _proc.poll() is not None:
                _dbg(f"engine died during configure: {why or 'no output'}")
                raise RuntimeError('Tetrarch stopped during configure' + (f': {why}' if why else ''))
            _dbg("no readyok within 30 s after configure; carrying on")
        return {'ok': True}

_request_lock = threading.Lock()
_request_counter = 0

def _number_request():
    # numbered as it ARRIVES (main), not when its turn on the engine worker comes: the worker runs
    # one at a time, so a number taken there would always be the newest and nothing queued behind a
    # search would ever be superseded
    global _request_counter
    with _request_lock:
        _request_counter += 1
        return _request_counter

def do_analyse(data, mid):
    request_id = data['_request']
    with engine_lock:
        if _request_counter != request_id:
            return {'superseded': True}     # a newer position arrived while we queued
        _start_engine()
        # FEN4 is a SINGLE TOKEN with the newlines stripped (RULES.md §11), and the
        # board is found by the LAST '-' in the string -- so it must never be split
        # or reflowed on the way here.
        fen4 = (data.get('fen4') or '').strip()
        setup = data.get('setup') or 'classic'
        moves = (data.get('moves') or '').strip()
        if fen4:
            pos = f"position fen4 {fen4}"
        else:
            pos = f"position startpos {setup}"
        if moves:
            pos += f" moves {moves}"
        _send(pos)

        lines, best = {}, None
        engine_error = []
        def on_line(l):
            if not l.startswith('info'):
                return
            # The engine reports a command it could not handle as `info string error ...`. After a
            # failed `go` no bestmove follows, so waiting for one cost the WHOLE bestmove timeout
            # (60s+) to learn nothing (2026-08-26: an FFA `go` with MultiPV died this way in Tetrarch
            # v8); after a failed `position` the `go` still runs, on the old board. Either way the
            # answer is this line, at once and in the engine's own words, and the engine is
            # discarded below rather than read on (audit 3.1.331 TETRARCHHOST-1).
            if l.startswith('info string error'):
                engine_error.append(l[len('info string '):])
                return
            info = parse_info(l)
            if not info:
                return
            lines[info.get('multipv', 1)] = info
            if _request_counter == request_id:
                send_message({'id': mid, 'info': info})

        ms = int(data.get('time') or 1000)
        _send(f"go movetime {ms}")
        # `stop` is accepted-and-ignored and the engine is single-threaded, so the
        # ONLY way a search ends is its own bestmove. Give it the move budget plus a
        # generous margin rather than a fixed timeout: a slow machine must not have
        # its answer declared missing while the engine is still working on it.
        bm = _read_until(lambda l: l.startswith('bestmove') or engine_error,
                         timeout=ms / 1000.0 + 60, on_line=on_line)
        if engine_error:
            _discard_engine(engine_error[0])
            raise RuntimeError(f'Tetrarch: {engine_error[0]}')
        if bm is None:
            # with the engine's own words when it left any: a crash mid-game ends in a traceback on
            # stderr, which the bare message dropped (audit 3.1.330 follow-up L36, as BOUNDARY-3 did
            # for startup)
            why = _stderr_why()
            _discard_engine('no bestmove before the deadline')   # one still searching would answer the next request
            raise RuntimeError('Tetrarch stopped responding' + (f': {why}' if why else ''))
        parts = bm.split()
        best = parts[1] if len(parts) > 1 else None
        ordered = [lines[k] for k in sorted(lines)]
        return {'bestmove': best,
                'threat': '(none)',
                'lines': ordered or [{'move': best, 'pv': [best] if best else []}]}

# A GAME, REPLAYED BY THE ENGINE'S OWN RULES. The extension has no 4-player rules of its own --
# chess.js cannot represent a 14x14 board with four seats, and reimplementing castling, promotion
# and elimination in JS to draw a review would be a second rulebook to keep in step with this one.
# Tetrarch's package already parses chess.com's PGN4 and steps it, handing back a FEN4 per ply
# "for a viewer to render without knowing any rules" (pgn4.replay's own words), so the analysis
# page asks for that instead of guessing.
def do_pgn4(data):
    # The engine runs as a SUBPROCESS for searching, so its package was never on this
    # interpreter's path -- importing it here needs the repo added first.
    try:
        if _repo not in sys.path:
            sys.path.insert(0, _repo)
        from tetrarch import pgn4
    except Exception as e:
        return {'error': f'Tetrarch package unavailable ({_repo}): {e}'}
    text = data.get('pgn4') or ''
    if not text.strip():
        return {'error': 'no PGN4 given'}
    try:
        game = pgn4.parse(text)
        frames, terminations = pgn4.replay(game)
    except Exception as e:
        # a malformed game is the user's paste, not a crash: name the ply if the parser knew it
        ply = getattr(e, 'ply', None)
        return {'error': str(e), 'ply': ply}
    return {'tags': game.tags, 'mode': str(game.mode), 'setup': game.setup,
            'variant': game.variant, 'frames': frames, 'terminations': terminations}

# THE HOST'S PROTOCOL REVISION (audit 3.1.330 BOUNDARY-2). The installer COPIES this file out of the
# extension, so updating the extension never updates the host Chrome runs. `ping` reports this
# number; the panel calls a host below its NATIVE_HOST_PROTOCOL (or one that reports none) out of date
# and says to re-run the installer. Bump it in every native-host/*-host.py and in popup.js together.
HOST_PROTOCOL = 1

def handle(msg):
    mid = msg.get('id')
    cmd = msg.get('cmd')
    _dbg(f"REQ  id={mid} cmd={cmd!r}")
    try:
        if cmd == 'analyse':
            res = do_analyse(msg, mid)
            _dbg(f"DONE id={mid} bestmove={res.get('bestmove')}")
            send_message({'id': mid, **res, 'done': True})
        elif cmd == 'pgn4':
            send_message({'id': mid, **do_pgn4(msg), 'done': True})
        elif cmd == 'configure':
            send_message({'id': mid, **do_configure(msg)})
        elif cmd == 'ping':
            # the panel's engine-health probe: answer WITHOUT launching the engine
            send_message({'id': mid, 'ok': True, 'protocol': HOST_PROTOCOL})
        else:
            send_message({'id': mid, 'error': f"unknown cmd {cmd!r}"})
    except Exception as e:
        _dbg(f"FAIL id={mid} {e!r}\n{traceback.format_exc()}")
        send_message({'id': mid, 'error': str(e)})

# configure and analyse run on ONE worker, in the order they arrived. One thread per message raced
# for engine_lock in whatever order the threads reached it, and the panel sends its Mode/MultiPV
# configure and the analyse after it back to back: about 1 search in 9 (35 of 300 in the audit's
# run) reached the engine first and was searched under the OLD Mode and line count (audit 3.1.331
# TETRARCHHOST-2). ping and pgn4 never touch the engine and keep their own threads, so a running
# search cannot hold up the panel's health probe.
_ENGINE_CMDS = ('analyse', 'configure')
_engine_q = queue.Queue()
def _engine_loop():
    while True:
        handle(_engine_q.get())

def main():
    threading.Thread(target=_sender_loop, daemon=True).start()
    threading.Thread(target=_engine_loop, daemon=True).start()
    while True:
        msg = read_message()
        if msg is None:
            break
        if msg.get('cmd') in _ENGINE_CMDS:
            if msg.get('cmd') == 'analyse':
                msg['_request'] = _number_request()
            _engine_q.put(msg)
        else:
            threading.Thread(target=handle, args=(msg,), daemon=True).start()
    try:
        if _proc and _proc.poll() is None:
            _proc.kill()
    except Exception:
        pass
    os._exit(0)   # finalizing here can SIGABRT on a held stdout lock

if __name__ == '__main__':
    main()
