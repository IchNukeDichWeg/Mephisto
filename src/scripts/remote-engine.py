# Example Usages:
#   $ python remote-engine.py /usr/bin/stockfish -o Hash:32 -o "Skill Level":15 -o SyzygyPath:"/path/to/syzygy" -p 9090
#   $ python remote-engine.py fairy-stockfish -o UCI_Variant:crazyhouse -p 9090
#   $ python remote-engine.py /path/to/engine -p 9090  (opening book works — book moves are handled below)

import argparse
import chess.engine
import chess.variant
from chess.engine import MANAGED_OPTIONS
from flask import Flask, request
import threading

engine_options = {}
request_counter = 0
engine_lock = threading.Lock()
request_lock = threading.Lock()

app = Flask(__name__)
parser = argparse.ArgumentParser(description='A backend to remotely communicate with a chess engine over UCI.')
parser.add_argument('executable', action='store', help='The path to the UCI chess engine executable.')
parser.add_argument('--option', '-o', dest='options', action='append',
                    help='Options to configure the engine.')
parser.add_argument('--port', '-p', dest='port', action='store', default=9090,
                    help='The port to run the server on. (default: 9090)')
args = parser.parse_args()

def format_line(line, terminal, bestmove):
    if line.get('pv'): # normal or book move that arrived with a full info line
        pv = list(map(lambda v: str(v), line.get('pv')))
        score_prefix = 'mate' if line.get('score').is_mate() else 'cp'
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
            'rawScore': f'{score_prefix} {line.get('score').relative}',
        }
        score = line.get('score').white()
        if line.get('score').is_mate():
            formatted_line['mate'] = score.mate()
        else:
            formatted_line['score'] = score.score()
        return formatted_line
    # no principal variation. game over is a property of the POSITION, not of the
    # engine output (a book move also arrives with no pv, and a superseded request
    # has no pv either) -- so key off `terminal`, never off a missing/null bestmove.
    if terminal: # the side to move has no legal move: real checkmate / stalemate
        score = line.get('score')
        if score is not None and score.is_mate(): # checkmate
            return {'move': '(none)', 'depth': line.get('depth', 0),
                    'rawScore': f'mate {score.relative}', 'mate': score.white().mate()}
        return {'move': '(none)', 'depth': line.get('depth', 0), # stalemate
                'rawScore': f'cp {score.relative if score is not None else 0}',
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
        return {
            'bestmove': pv0[0],
            'threat': pv0[1] if len(pv0) > 1 else '(none)',
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
    global request_counter, request_lock

    with request_lock:
        request_counter += 1
        request_id = request_counter

    with engine_lock:
        data = request.get_json()
        if 'fen' not in data:
            return {'error': "Parameter 'fen' is required"}, 400
        elif 'time' not in data:
            return {'error': "Parameter 'time' is required"}, 400

        variant = engine_options.get('UCI_Variant')
        if variant is None:
            board = chess.Board(data.get('fen'))
        elif variant == 'fischerandom':
            board = chess.Board(data.get('fen'), chess960=True)
        else:
            VariantBoard = chess.variant.find_variant(variant)
            board = VariantBoard(data.get('fen'))

        if data.get('moves'):
            for move in data.get('moves').split():
                board.push(chess.Move.from_uci(move))
        time_limit = chess.engine.Limit(time=data.get('time') / 1000)
        multipv = int(engine_options.get('MultiPV', 1))
        if 'multipv' not in engine.options:
            multipv = 1 # engine doesn't declare MultiPV support — don't ask for it

        terminal = not any(board.legal_moves) # authoritative game-over signal
        with engine.analysis(board, time_limit, multipv=multipv) as analysis:
            bestmove = None
            if request_counter == request_id: #
                for _ in analysis:
                    if request_counter != request_id:
                        break # request was cancelled
                if request_counter == request_id:
                    bestmove = analysis.wait().move # actual move (search or book)
        return format_lines(analysis.multipv, terminal, bestmove)


@app.route('/configure', methods=['POST'])
def configure():
    with engine_lock:
        data = request.get_json()
        for (key, value) in data.items():
            engine_options[key] = value
            if key.lower() in MANAGED_OPTIONS:
                continue
            if key not in engine.options:
                print(f"ignoring option '{key}' — not declared by this engine")
                continue
            engine.configure({key: value})
        return config()


@app.route('/config', methods=['GET'])
def config():
    cfg = dict(engine.protocol.config)
    cfg.update(engine_options)
    return cfg


if __name__ == '__main__':
    engine = chess.engine.SimpleEngine.popen_uci(args.executable)
    for option in args.options or []:
        key, value = option.split(':')
        engine_options[key] = value
        if key.lower() in MANAGED_OPTIONS:
            continue
        if key not in engine.options:
            print(f"ignoring option '{key}' — not declared by this engine")
            continue
        engine.configure({key: value})
    app.run(port=args.port)
