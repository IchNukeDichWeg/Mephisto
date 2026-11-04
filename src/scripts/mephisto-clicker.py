import ctypes
import ctypes.util
import sys
from random import random

import pyautogui
import argparse
from flask import Flask, abort, request
from werkzeug.exceptions import HTTPException

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


# type=int on all three: without it a value given on the command line stayed a str, and the duration
# sum raised TypeError on every click, so `-d 150` turned the clicker into a 500 for every move (audit
# 3.1.330 NATIVEA-2). Only the int defaults had ever been run.
parser = argparse.ArgumentParser(description='A backend to perform simulated clicks for the Mephisto chrome extension.')
parser.add_argument('--port', '-p', dest='port', action='store', type=int, default=8080,
                    help='The port to run the server on. The extension only calls 8080, so any other '
                         'port is for testing by hand. (default: 8080)')
parser.add_argument('--drag-time', '-d', dest='drag_time', action='store', type=int, default=100,
                    help='Time to drag a piece in ms. (default: 100) [with defaults: 100ms - 120ms]')
parser.add_argument('--drag-var', '-v', dest='drag_variance', action='store', type=int, default=20,
                    help='Variance for time to drag a piece in ms. (default: 20)')
args = parser.parse_args()


@app.errorhandler(Exception)
def _error_as_json(e):
    # The panel shows this text (backend_clicked), so a failure here says what went wrong instead of
    # the panel guessing "not running" from a bare 500 page (audit 3.1.330 SWALLOW-8).
    if isinstance(e, HTTPException):
        return {'error': e.description}, e.code
    app.logger.exception('click failed')
    return {'error': f'{type(e).__name__}: {e}'}, 500


def _display_test():
    # ON ANY DISPLAY, NOT THE PRIMARY ONE. The issue #36 clamp cut every point to pyautogui.size(),
    # which is the primary display only on Windows and macOS, while the extension sends virtual-desktop
    # coordinates (window.screenX spans every display). A board on a second display was clicked at the
    # primary display's edge, on whatever app sat there, and the clicker still answered OK (audit
    # 3.1.330 NATIVEA-1). These ask the OS whether a display holds the point, in the same space
    # pyautogui moves in. On X11 the root window pyautogui.size() reads already spans every monitor.
    try:
        if sys.platform == 'win32':
            class POINT(ctypes.Structure):
                _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
            monitor_from_point = ctypes.windll.user32.MonitorFromPoint
            monitor_from_point.argtypes = [POINT, ctypes.c_uint32]
            monitor_from_point.restype = ctypes.c_void_p
            return lambda x, y: bool(monitor_from_point(POINT(x, y), 0))   # 0 = MONITOR_DEFAULTTONULL
        if sys.platform == 'darwin':
            class CGPoint(ctypes.Structure):
                _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
            cg = ctypes.CDLL(ctypes.util.find_library('CoreGraphics'))
            cg.CGGetDisplaysWithPoint.argtypes = [CGPoint, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32),
                                                  ctypes.POINTER(ctypes.c_uint32)]
            cg.CGGetDisplaysWithPoint.restype = ctypes.c_int32

            def on_mac_display(x, y):
                ids, n = (ctypes.c_uint32 * 16)(), ctypes.c_uint32(0)
                return cg.CGGetDisplaysWithPoint(CGPoint(x, y), 16, ids, ctypes.byref(n)) == 0 and n.value > 0
            return on_mac_display
    except (AttributeError, OSError, TypeError) as e:
        print(f'NOTE: cannot list the displays ({e}); clicks are limited to the primary display.')
    return lambda x, y: pyautogui.onScreen(x, y)


on_a_display = _display_test()


def _mac_event_access():
    # MACOS DROPS THE CLICKS WITHOUT A WORD. Until the app running this script is allowed under
    # Privacy & Security > Accessibility, the OS discards every synthetic mouse event, pyautogui raises
    # nothing, and the clicker answered OK to clicks that never happened while Autoplay re-sent the
    # move forever (audit 3.1.330 SWALLOW-9). Returns (check, ask): whether events may be posted now,
    # and a call that raises the OS permission prompt. Elsewhere, or where macOS cannot tell, as before.
    if sys.platform == 'darwin':
        try:
            cg = ctypes.CDLL(ctypes.util.find_library('CoreGraphics'))
            check, ask = cg.CGPreflightPostEventAccess, cg.CGRequestPostEventAccess   # macOS 10.15+
            check.restype = ask.restype = ctypes.c_bool
            return (lambda: bool(check())), ask
        except (AttributeError, OSError, TypeError):
            pass
    return (lambda: True), (lambda: True)


may_post_events, ask_post_events = _mac_event_access()
MAC_ACCESS_TEXT = ('macOS does not let this program control the mouse. Allow the app running mephisto-clicker.py '
                   'under System Settings > Privacy & Security > Accessibility, then restart it.')


@app.before_request
def _refuse_without_event_access():
    # a 503 makes the panel play the move with its own clicks and show this text
    if request.path.startswith('/perform') and not may_post_events():
        return {'error': MAC_ACCESS_TEXT}, 503


def _target(data, kx, ky):
    # A point off every display is refused rather than moved to an edge: the 400 makes the panel play
    # the move with its own clicks, where a clamped click landed on another window (issue #36 §2 asked
    # only that a bad caller cannot drive clicks off into the void).
    try:
        x, y = int(data[kx]), int(data[ky])
    except (KeyError, TypeError, ValueError, OverflowError):
        abort(400, f'bad or missing coordinates {kx}, {ky}')
    if not on_a_display(x, y):
        abort(400, f'({x}, {y}) is not on any display, so it was not clicked')
    return x, y


def perform_click(x, y):
    duration = (args.drag_variance * random() + args.drag_time) / 1000
    pyautogui.moveTo(x, y, duration=duration)
    pyautogui.mouseDown()
    pyautogui.mouseUp()


def perform_move(x0, y0, x1, y1):
    perform_click(x0, y0)
    # pause between pick-up and drop, scaled the same way perform_click's own drag duration is --
    # a flat 4s here (S6) made every simulated move visibly slower than a human's hold-and-drop
    pyautogui.sleep((args.drag_variance * random() + args.drag_time) / 1000)
    perform_click(x1, y1)


def perform_drag(x0, y0, x1, y1, ms=0):
    # ONE GESTURE: press on the piece, carry it with the button held, release on the target. Boards
    # that ignore click-click (chess.com /variants/ captures, ChessBase's dragOnly board) got two
    # clicks from this backend, answered OK, and the move looped until the clock ran out (audit
    # 3.1.330 CLICKA-3). The carry lasts at least `ms`, the floor the content script asks for
    # (DRAG_MIN_MS there: a snapped drag dropped captures), capped so a bad value cannot hold the mouse.
    pyautogui.moveTo(x0, y0, duration=(args.drag_variance * random() + args.drag_time) / 1000)
    carry = max((args.drag_variance * random() + args.drag_time) / 1000, min(max(ms, 0), 2000) / 1000)
    pyautogui.dragTo(x1, y1, duration=carry, button='left')


@app.route('/performClick', methods=['POST'])
def perform_click_api():
    data = request.get_json(silent=True) or {}
    perform_click(*_target(data, 'x', 'y'))
    return 'OK'


@app.route('/performMove', methods=['POST'])
def perform_move_api():
    data = request.get_json(silent=True) or {}
    perform_move(*_target(data, 'x0', 'y0'), *_target(data, 'x1', 'y1'))
    return 'OK'


@app.route('/performDrag', methods=['POST'])
def perform_drag_api():
    data = request.get_json(silent=True) or {}
    ms = data.get('ms')
    perform_drag(*_target(data, 'x0', 'y0'), *_target(data, 'x1', 'y1'),
                 ms if isinstance(ms, (int, float)) and ms == ms else 0)
    return 'OK'


if __name__ == '__main__':
    if args.port != 8080:
        # the worker's relay allowlist (background-script.js BACKEND_URLS) pins 8080 (audit 3.1.330 CLICKA-4)
        print(f'NOTE: the extension only calls port 8080; on port {args.port} it cannot reach this server.')
    if not may_post_events():
        print('WARNING: ' + MAC_ACCESS_TEXT)
        ask_post_events()   # macOS shows its own prompt that opens the right settings page
    app.run(host='127.0.0.1', port=args.port)  # loopback only - never expose on the LAN
