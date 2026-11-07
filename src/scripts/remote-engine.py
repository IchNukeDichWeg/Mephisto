# Mephisto remote engine - runs a local UCI chess engine (Stockfish, Fairy-Stockfish, ...) and lets
# the browser extension talk to it over localhost. Keep this window open while you play, then set the
# extension's Engine to "Remote Engine".
#
# Requires:  pip install python-chess flask
#
# Examples:
#   python remote-engine.py /usr/bin/stockfish -o Hash:128 -o "Skill Level":15 -p 9090
#   python remote-engine.py fairy-stockfish -o UCI_Variant:crazyhouse -p 9090

import argparse
import json
import sys
import threading

# Friendly message instead of a raw ImportError traceback when the packages aren't installed.
try:
    import chess
    import chess.engine
    import chess.variant
    from chess.engine import MANAGED_OPTIONS
    from flask import Flask, request
    from werkzeug.exceptions import HTTPException
except ImportError as e:
    sys.exit(f"Missing required package: {getattr(e, 'name', e)}\n"
             f"Install everything this script needs with:\n"
             f"    pip install python-chess flask")

engine = None
engine_options = {}
request_counter = 0
current_analysis = None  # the search running now, so a newer /analyse can stop it at once
configure_cut = None     # the search a /configure stopped, so its answer says superseded
requested_options = {}   # every value /configure was sent, taken or not: what "nothing to change" compares
refused_keys = set()     # the keys the engine did not take, for a /configure that changes nothing
engine_lock = threading.Lock()
request_lock = threading.Lock()

app = Flask(__name__)


# The sites the extension runs on (mirrors manifest.json content_scripts matches). The panel runs in
# the page's isolated world, so its fetches carry the SITE's Origin - not chrome-extension://.
ALLOWED_HOSTS = {'www.chess.com', 'lichess.org', 'blitztactics.com', 'taketaketake.com',
                 'www.taketaketake.com', 'tactics.chessbase.com'}


@app.before_request
def _reject_foreign_origins():
    # Only the extension may drive this server (issue #36 §2): allow extension-context fetches,
    # fetches from the sites the panel runs on, and no-Origin callers (curl / manual testing) - 
    # the guard targets requests from arbitrary web pages. An Origin header can't be spoofed by
    # page script.
    origin = request.headers.get('Origin', '')
    if not origin or origin.startswith('chrome-extension://'):
        return
    host = origin.split('://', 1)[-1].split('/', 1)[0].split(':', 1)[0]
    if host not in ALLOWED_HOSTS:
        return {'error': 'forbidden origin'}, 403


parser = argparse.ArgumentParser(description='A backend to remotely communicate with a chess engine over UCI.')
parser.add_argument('executable', action='store', help='The path to the UCI chess engine executable.')
parser.add_argument('--option', '-o', dest='options', action='append',
                    help='Options to configure the engine, as NAME:VALUE (e.g. -o Hash:128).')
# The extension only ever calls 9090: the worker's relay allowlist (background-script.js BACKEND_URLS)
# pins it, so any other port is for testing by hand (audit 3.1.330 follow-up L19, as the clicker's --port).
parser.add_argument('--port', '-p', dest='port', action='store', type=int, default=9090,
                    help='The port to run the server on. The extension only calls 9090, so any other '
                         'port is for testing by hand. (default: 9090)')
args = parser.parse_args()


def set_option(key, value):
    # Apply one already-parsed engine option. `value` keeps its native type (str from the CLI, but
    # int/bool from the extension's JSON - e.g. Hash:512, UCI_LimitStrength:true) so python-chess
    # gets the type it expects. Never crashes the server on a bad option. Returns False when the engine
    # did not take it (not declared, or refused), so /configure can say so. engine_options keeps only
    # what the engine took, at the value it took (a clamped spin as clamped): it was written before
    # these checks, so GET /config listed UCI_Elo on an engine without one (audit 3.1.330 follow-up L49).
    key = str(key).strip()
    if not key:
        return True
    if key.lower() in MANAGED_OPTIONS:
        engine_options[key] = value
        return True  # python-chess manages these itself; setting them directly would fight it
    if key not in engine.options:
        print(f"ignoring option '{key}' - this engine doesn't offer it")
        return False
    # A number outside the engine's own range is clamped to it (audit 3.1.330 SWALLOW-2): python-chess
    # refuses it outright, and the panel sends UCI_LimitStrength just before UCI_Elo, so a cap of 3000
    # on an engine whose UCI_Elo stops at 2850 left it limited at its DEFAULT Elo (1350 on Stockfish
    # 11) while the panel showed 3000.
    opt = engine.options[key]
    if getattr(opt, 'type', None) == 'spin' and not isinstance(value, bool):
        try:
            number = int(value)
        except (TypeError, ValueError):
            number = None
        if number is not None:
            clamped = number
            if opt.max is not None:
                clamped = min(clamped, opt.max)
            if opt.min is not None:
                clamped = max(clamped, opt.min)
            if clamped != number:
                print(f"{key} = {value} is outside this engine's range {opt.min}-{opt.max} - using {clamped}")
                value = clamped
    try:
        engine.configure({key: value})
    except Exception as ex:
        print(f"couldn't set {key} = {value}: {ex}")
        return False
    engine_options[key] = value
    return True


def take_options(keys):
    # Apply (key, value) pairs the panel sent, through /configure or on an /analyse, and remember each
    # as requested. Returns the keys the engine did not take.
    refused = []
    for (key, value) in keys:
        if set_option(key, value):
            refused_keys.discard(key)
        else:
            refused.append(key)
            refused_keys.add(key)
        requested_options[key] = value
    return refused


def engine_dead():
    try:
        return engine.protocol.returncode.done()
    except Exception:
        return False


def relaunch_if_dead():
    # A DEAD ENGINE IS STARTED AGAIN (audit 3.1.331 REMOTEENGINE-2), as uci-native-host.py has done
    # since audit 3.1.329 NATIVE-4. Once Stockfish exited (on a position it rejects, or killed), every
    # later request answered 500 "engine event loop dead", a valid position too, until this script was
    # restarted. The new process gets every option the old one took, from -o and from the panel.
    global engine
    if engine is None or not engine_dead():
        return
    print('the engine stopped - starting it again')
    try:
        engine.close()
    except Exception:
        pass
    try:
        engine = chess.engine.SimpleEngine.popen_uci(args.executable)
    except Exception as ex:
        raise chess.engine.EngineTerminatedError(f"couldn't start the engine again: {ex}")
    for (key, value) in list(engine_options.items()):
        set_option(key, value)


def apply_option(opt):
    # Parse one CLI "NAME:VALUE" string, then apply it. Splits on the FIRST colon only, so values
    # containing ':' survive (Windows paths like C:\syzygy). Tolerates typos.
    if opt is None:
        return
    if ':' not in opt:
        print(f"skipping malformed option '{opt}' - expected NAME:VALUE, e.g. -o Hash:128")
        return
    key, value = opt.split(':', 1)
    set_option(key.strip(), value.strip())


# What a position may get wrong and still be searched: Stockfish reads stale castling rights, a stale
# en passant square and an impossible check without complaint (measured with Stockfish 19).
PLAYABLE_ANYWAY = (chess.STATUS_BAD_CASTLING_RIGHTS | chess.STATUS_INVALID_EP_SQUARE
                   | chess.STATUS_IMPOSSIBLE_CHECK | chess.STATUS_TOO_MANY_CHECKERS)


def build_board(fen, moves):
    # Build the position, raising ValueError with a clear message on bad input. An illegal move or a
    # position that is not chess (the side not to move in check, a missing king, a pawn on the back
    # rank, nine pawns) is refused HERE: Stockfish answers one with CRITICAL ERROR and exits, and
    # board.push() took any move at all, e2e5 from the start included (audit 3.1.331 REMOTEENGINE-2).
    variant = engine_options.get('UCI_Variant')
    if variant is None:
        board = chess.Board(fen)
    elif variant == 'fischerandom':
        board = chess.Board(fen, chess960=True)
    else:
        VariantBoard = chess.variant.find_variant(variant)
        board = VariantBoard(fen)
    bad = board.status() & ~PLAYABLE_ANYWAY
    if bad:
        why = [name[7:].lower().replace('_', ' ') for name in dir(chess)
               if name.startswith('STATUS_') and getattr(chess, name) & bad]
        raise ValueError(f"not a legal position ({', '.join(why)})")
    for (ply, move) in enumerate((moves or '').split(), 1):
        try:
            parsed = board.parse_uci(move)
        except ValueError:
            parsed = None
        if not parsed:  # parse_uci returns the null move for '0000'
            raise ValueError(f'move {ply} ({move}) is not legal in that position')
        board.push(parsed)
    return board


def format_line(line, terminal, bestmove):
    if line.get('pv'): # normal or book move that arrived with a full info line
        pv = list(map(lambda v: str(v), line.get('pv')))
        score = line.get('score')
        score_prefix = 'mate' if score.is_mate() else 'cp'
        relative = score.relative # extracted so the f-string has no nested quotes (older-Python safe)
        formatted_line = {
            'depth': line.get('depth'),
            'seldepth': line.get('seldepth'),
            'multipv': line.get('multipv'),
            'nodes': line.get('nodes'),
            'nps': line.get('nps'),
            'hashfull': line.get('hashfull'),
            'tbhits': line.get('tbhits'),
            'time': line.get('time'),
            'move': pv[0],
            'pv': pv,
            'rawScore': f'{score_prefix} {relative}',
        }
        white = score.white()
        if score.is_mate():
            formatted_line['mate'] = white.mate()
        else:
            formatted_line['score'] = white.score()
        # S8: bring this copy up to parity with uci-native-host.py -- the Remote backend was the
        # only UCI-speaking backend with no WDL bar and no aspiration-window flag.
        if line.get('lowerbound') or line.get('upperbound'):
            formatted_line['bound'] = True
        wdl = line.get('wdl')  # present only when the engine declares UCI_ShowWDL
        if wdl is not None:
            try:
                w = wdl.white()  # -> Wdl(wins, draws, losses) from White's perspective, permille
                formatted_line['wdl'] = [w.wins, w.draws, w.losses]  # [white, draw, black]
            except Exception:
                pass  # unexpected wdl shape (old python-chess) -- just omit it, never crash analyse
        return formatted_line
    # no principal variation. game over is a property of the POSITION, not of the
    # engine output (a book move also arrives with no pv, and a superseded request
    # has no pv either) -- so key off `terminal`, never off a missing/null bestmove.
    if terminal: # the side to move has no legal move: real checkmate / stalemate
        score = line.get('score')
        if score is not None and score.is_mate(): # checkmate
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': f'mate {score.relative}', 'mate': score.white().mate()}
        relative = score.relative if score is not None else 0 # stalemate
        return {'move': '(none)', 'depth': line.get('depth', 0),
                'rawScore': f'cp {relative}',
                'score': score.white().score() if score is not None else 0}
    if bestmove is not None and bestmove != chess.Move.null(): # book move played with no info line
        return {'move': bestmove.uci(), 'depth': line.get('depth', 0),
                'pv': [bestmove.uci()], 'rawScore': 'cp 0', 'score': 0}
    # not terminal and no move yet (request superseded before any info) -- non-fatal placeholder
    return {'move': '(none)', 'depth': line.get('depth', 0), 'rawScore': 'cp 0', 'score': 0}


def format_lines(lines, terminal, bestmove):
    lines = list(map(lambda line: format_line(line, terminal, bestmove), lines or [{}]))
    if 'pv' in lines[0]:
        pv0 = lines[0].get('pv')
        best, threat = pv0[0], pv0[1] if len(pv0) > 1 else '(none)'
        # a partial deeper iteration can change the engine's FINAL bestmove after the last
        # completed info line -- the true bestmove wins (as in uci-native-host.py)
        if bestmove is not None and bestmove != chess.Move.null() and bestmove.uci() != best:
            best, threat = bestmove.uci(), '(none)'
        return {
            'bestmove': best,
            'threat': threat,
            'lines': lines,
        }
    else:
        return {
            'bestmove': '(none)',
            'threat': '(none)',
            'lines': lines,
        }


def format_score(score, depth):
    return {
        'is_mate': score.is_mate(),
        'value': score.mate() if score.is_mate() else score.score(),
        'depth': depth,
    }


@app.route('/analyse', methods=['POST'])
def analyse():
    global request_counter, request_lock, current_analysis, configure_cut

    with request_lock:
        request_counter += 1
        request_id = request_counter
        # Stop the search this request supersedes NOW. The loop below only notices a newer request at
        # the engine's next info line, which deep in a search is seconds away (measured with Stockfish:
        # a 300 ms request took up to 5.9 s behind a superseded one, 0.37 s with this stop). The
        # extension's call waits on a fetch that Chrome cuts at 30 s, so that queue time came out of
        # the new search's budget (audit 3.1.329 ENGINE-1). Set and read under request_lock, so a
        # search either sees the bumped counter before it starts or is in current_analysis here to
        # be stopped.
        if current_analysis is not None:
            current_analysis.stop()

    with engine_lock:
        relaunch_if_dead()
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return {'error': 'expected a JSON object in the request body'}, 400
        if 'fen' not in data:
            return {'error': "Parameter 'fen' is required"}, 400
        if 'time' not in data:
            return {'error': "Parameter 'time' is required"}, 400
        try:
            time_ms = float(data.get('time'))
        except (TypeError, ValueError):
            return {'error': "Parameter 'time' must be a number (milliseconds)"}, 400
        if time_ms <= 0:
            return {'error': "Parameter 'time' must be greater than 0"}, 400

        # THE PANEL'S SETTINGS RIDE ON EVERY SEARCH (audit 3.1.331 REMOTEENGINE-1). They came only from
        # the /configure the panel sends once when it starts, so a server started after the panel (what
        # MPH-E02 tells you to do) or restarted under it never had them: no Elo cap, and with no
        # UCI_Variant a Chess960 game was built as standard chess, whose first castle killed Stockfish.
        # Only a value that differs from the last one sent is applied, so a steady game sets nothing.
        options = data.get('options')
        sent, changed = [], []
        if isinstance(options, dict):
            sent = [(str(key).strip(), value) for (key, value) in options.items()]
            changed = [(key, value) for (key, value) in sent
                       if not (key in requested_options and requested_options[key] == value)]
            take_options(changed)

        try:
            board = build_board(data.get('fen'), data.get('moves'))
        except ValueError as ex:
            return {'error': f'invalid position: {ex}'}, 400

        # S5: nodes/depth read before the time fallback -- same precedence as uci-native-host.py
        # (nodes > depth > time), so Analysis Limit's nodes/depth units work on the Remote backend too.
        depth = data.get('depth')
        nodes = data.get('nodes')
        if isinstance(nodes, int) and nodes > 0:
            time_limit = chess.engine.Limit(nodes=nodes, time=time_ms / 1000)
        elif isinstance(depth, int) and depth > 0:
            time_limit = chess.engine.Limit(depth=depth, time=time_ms / 1000)
        else:
            time_limit = chess.engine.Limit(time=time_ms / 1000)
        # The width the request carries wins over the stored one. The panel sends a changed width as a
        # /configure beside this request, and the two run on separate threads that only meet at
        # engine_lock, so either can go first: measured with Stockfish, 9 of 20 searches sent with no
        # gap after their configure came back at the OLD width (audit 3.1.330 follow-up L17).
        # Stored too, so a later request without the key keeps it.
        width = data.get('multipv')
        if isinstance(width, int) and not isinstance(width, bool) and width > 0:
            engine_options['MultiPV'] = requested_options['MultiPV'] = width
        try:
            multipv = int(engine_options.get('MultiPV', 1))
        except (TypeError, ValueError):
            multipv = 1
        if 'multipv' not in engine.options:
            multipv = 1 # engine doesn't support MultiPV - don't ask for it
        else:
            # Humanize asks for MultiPV 20; clamp to this engine's declared range or
            # python-chess rejects it ("expected value for option 'MultiPV' to be at most N").
            opt = engine.options['MultiPV']
            if opt.max is not None:
                multipv = min(multipv, opt.max)
            if opt.min is not None:
                multipv = max(multipv, opt.min)

        terminal = not any(board.legal_moves) # authoritative game-over signal
        try:
            with engine.analysis(board, time_limit, multipv=multipv) as analysis:
                with request_lock:
                    current_analysis = analysis
                try:
                    bestmove = None
                    if request_counter == request_id:
                        for _ in analysis:
                            if request_counter != request_id:
                                break # request was cancelled
                        if request_counter == request_id:
                            bestmove = analysis.wait().move # actual move (search or book)
                finally:
                    with request_lock:
                        if current_analysis is analysis:
                            current_analysis = None
                        cut = configure_cut is analysis
            out = format_lines(analysis.multipv, terminal, bestmove)
            # Cut short by a newer request or a /configure: say so, or the panel plays the shallow line
            # (or a `(none)`) as an answer. Its retry fires on this flag, as with the native hosts.
            if request_counter != request_id or cut:
                out['superseded'] = True
            # As /configure answers, when this search changed any option: the panel's Elo label
            # learns here whether a cap took on a server that never saw its configure.
            if changed:
                out['refused_options'] = [key for (key, value) in sent if key in refused_keys]
            return out
        except chess.engine.EngineTerminatedError:
            return {'error': 'the engine process stopped on this position - it starts again on the next request'}, 503


@app.route('/configure', methods=['POST'])
def configure():
    global configure_cut
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return {'error': 'expected a JSON object in the request body'}, 400
    keys = [(str(key).strip(), value) for (key, value) in data.items()]
    # STOP THE RUNNING SEARCH FIRST, then take the lock, as a native host supersedes its own search.
    # Queued behind it, a new line count from the panel waited out the whole search, up to the 25 s
    # the HTTP Remote is given (measured with Stockfish: 19.5 s behind a 20 s search), before
    # search_again_at_new_width could search again (audit 3.1.330 follow-up L50). The search it stops
    # was not answered: its reply says superseded and the panel searches again. Nothing to change,
    # nothing to stop: the panel re-sends a width its /analyse already carried. A configure that lands
    # in the few ms between a search taking the lock and registering itself still waits (as natively).
    with request_lock:
        if all(key in requested_options and requested_options[key] == value for (key, value) in keys):
            out = config()
            out['refused_options'] = [key for (key, value) in keys if key in refused_keys]
            return out
        stale = current_analysis
        if stale is not None:
            configure_cut = stale
    if stale is not None:
        try:
            stale.stop()
        except Exception:
            pass
    with engine_lock:
        relaunch_if_dead()
        # The keys the engine did not take ride back beside the options. An engine with no UCI_Elo
        # (Lc0) played at full strength while the panel showed the cap; this is how the panel learns
        # it did not apply (audit 3.1.330 follow-up L38).
        refused = take_options(keys)
        out = config()
        out['refused_options'] = refused
        return out


@app.route('/config', methods=['GET'])
def config():
    cfg = dict(engine.protocol.config)
    cfg.update(engine_options)
    return cfg


@app.errorhandler(Exception)
def on_unexpected_error(e):
    # Flask's own HTTP errors (a wrong route or method) answer in JSON too, keeping their status and
    # headers (Allow on a 405). As Flask's HTML page the panel read them as "something other than
    # remote-engine.py is answering" (MPH-E03), which sent people to look for another program on the
    # port (audit 3.1.330 follow-up L18). Anything else becomes a clean JSON 500, never a traceback page.
    if isinstance(e, HTTPException):
        resp = e.get_response()
        resp.set_data(json.dumps({'error': f'{e.code} {e.name}: {e.description}'}))
        resp.content_type = 'application/json'
        return resp
    if isinstance(e, chess.engine.EngineTerminatedError):  # died outside a search, or did not restart
        print(f"engine stopped: {e}")
        return {'error': f'the engine process stopped: {e}'}, 503
    print(f"unexpected error: {e}")
    return {'error': f'internal error: {e}'}, 500


def start_engine(path):
    try:
        return chess.engine.SimpleEngine.popen_uci(path)
    except FileNotFoundError:
        sys.exit(f"Couldn't find an engine at: {path}\n"
                 f"Check the path is right - tip: drag the engine file into the terminal to paste its full path.")
    except PermissionError:
        sys.exit(f"The engine at {path} isn't executable.\n"
                 f"On macOS/Linux, run:  chmod +x \"{path}\"")
    except Exception as ex:
        sys.exit(f"Couldn't start the engine at {path}:\n    {ex}")


if __name__ == '__main__':
    engine = start_engine(args.executable)
    for option in args.options or []:
        apply_option(option)
    if args.port != 9090:
        print(f'NOTE: the extension only calls port 9090; on port {args.port} it cannot reach this server.')
    print(f"Mephisto remote engine ready at http://localhost:{args.port}")
    print("In the extension, set Engine = \"Remote Engine\". Keep this window open while you play.")
    print("Press Ctrl+C here to stop.")
    try:
        # S2: threaded=True -- single-threaded Werkzeug meant /configure queued behind a running
        # /analyse and request_counter supersession (above) could never actually fire.
        app.run(host='127.0.0.1', port=args.port, threaded=True)  # loopback only - never expose on the LAN
    except OSError as ex:
        sys.exit(f"Couldn't start the server on port {args.port}:\n    {ex}\n"
                 f"That port may already be in use (is this script already running?). "
                 f"Stop whatever holds it: the extension only calls port 9090.")
    except SystemExit as ex:
        # Werkzeug reports a port in use itself, advises "a different port" and exits, so the OSError
        # branch above never sees it. The extension cannot follow the server to another port.
        if ex.code not in (None, 0):
            print("The extension only calls port 9090: free that port rather than moving this server.",
                  file=sys.stderr)
        raise
    finally:
        if engine is not None:
            engine.quit()
