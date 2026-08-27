#!/usr/bin/env python3
# THE PANEL'S PROGRESS BAR IS REPLACED BY A MOVE ON THE FIRST `info` FRAME of the new search, so the
# gap between a position changing and that frame IS the "loading" a user sees. With Autoplay off or
# Help Mode on the panel runs an open-ended search, so a new position always arrives with one still
# running -- and until uci-native-host.py stopped the outstanding search, the supersession was only
# noticed on its NEXT info frame, which at depth is hundreds of ms away.
#
# MEASURED (SF18, 1 thread, 8s budget, a middlegame position): 443 / 220 / 645ms before, 1ms after.
#
# Runs against any UCI engine on PATH; skips (exit 0) when there is none and when python-chess is
# missing, so it costs nothing on a machine that cannot run it. One thread, one short search.
import json, os, shutil, struct, subprocess, sys, tempfile, threading, time

BUDGET_MS = 8000
LIMIT_MS = 60          # the gap this is guarding against; it was measured in the hundreds
DEEP = 'r2q1rk1/pp1bbppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 10'
NEXT = 'r2q1rk1/pp1bbppp/5n2/2pp4/3Pn3/2PBPN2/PP1N1PPP/R2QRBK1 b - - 3 12'

def skip(why):
    print(f'SKIP: {why}')
    sys.exit(0)

try:
    import chess.engine  # noqa: F401  -- the host needs it, not this file
except ImportError:
    skip('python-chess is not installed')
engine = next((p for p in (shutil.which('stockfish'), shutil.which('fairy-stockfish')) if p), None)
if not engine:
    skip('no UCI engine on PATH')

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='mephisto-host-test-')
host = os.path.join(tmp, 'probe-host.py')          # a distinct name: the host reads <slug>.path
shutil.copy(os.path.join(here, 'uci-native-host.py'), host)
open(os.path.join(tmp, 'probe.path'), 'w').write(engine + '\n')

p = subprocess.Popen([sys.executable, host], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def send(obj):
    b = json.dumps(obj).encode()
    p.stdin.write(struct.pack('<I', len(b)) + b)
    p.stdin.flush()
frames, lock = [], threading.Lock()
def read():
    while True:
        head = p.stdout.read(4)
        if len(head) < 4:
            return
        msg = json.loads(p.stdout.read(struct.unpack('<I', head)[0]))
        with lock:
            frames.append((time.perf_counter(), msg))
threading.Thread(target=read, daemon=True).start()

send({'id': 0, 'cmd': 'configure', 'options': {'Threads': 1, 'Hash': 16, 'MultiPV': 1}})
time.sleep(3)                                       # engine boot is not what is being measured

# THREE ARMS, and the WORST one decides. How long the old search takes to notice depends on where in
# its iteration the position changed -- one sample of it landed at 43ms on the very build this test
# exists to catch, which would have passed. The spread is the measurement.
def arm(after_s, mid):
    send({'id': 1, 'cmd': 'analyse', 'fen': DEEP, 'time': BUDGET_MS})
    time.sleep(after_s)
    t0 = time.perf_counter()
    send({'id': mid, 'cmd': 'analyse', 'fen': NEXT, 'time': BUDGET_MS})
    gap = None
    while gap is None and time.perf_counter() - t0 < 12:
        with lock:
            gap = next(((t - t0) * 1000 for t, m in frames
                        if t >= t0 and m.get('id') == mid and 'info' in m), None)
        time.sleep(0.005)
    return gap

gaps = []
for i, after in enumerate((1, 2, 4)):
    g = arm(after, 100 + i)
    print(f'  arm {i + 1}/3: position changed {after}s in -> first info after '
          f'{"never (>12s)" if g is None else "%.0fms" % g}', flush=True)
    gaps.append(g)
    time.sleep(9)                                   # let the superseding search finish on its own
p.kill()
shutil.rmtree(tmp, ignore_errors=True)

if any(g is None for g in gaps):
    print('FAIL a superseding search never produced an info frame')
    sys.exit(1)
worst = max(gaps)
print(f'worst wait for the new position\'s first info frame: {worst:.0f}ms (limit {LIMIT_MS}ms)')
sys.exit(0 if worst <= LIMIT_MS else 1)
