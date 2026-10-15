#!/usr/bin/env python3
"""Stage C, step 2: look every sampled player up on lichess and record whether the account is
marked for a TOS violation, closed, or gone. Resumable.

  POST https://lichess.org/api/users   body: comma-separated ids (<= 300), text/plain
  Documented limits: 8,000 users per 10 minutes, 120,000 per day; on HTTP 429 wait a full minute.

The state file is append-only TSV, one line per user: `name<TAB>status<TAB>unix_time`, written and
flushed after every request. A re-run skips every name already in it and rebuilds the 10-minute
and 24-hour windows from the timestamps, so Ctrl-C (or a reboot) followed by the same command
continues where it stopped and still respects the daily limit across the restart. At most the one
request in flight when interrupted is repeated.

Status: ok | tos (tosViolation) | closed (disabled) | closed_tos | missing (asked for, not in the
answer) | invalid (not a possible lichess id; never sent). Owner decision 5: aggregate.py drops a
game when either side is anything but ok.
"""
import argparse
import bisect
import collections
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import study_core as sc

URL = 'https://lichess.org/api/users'
UA = 'mephisto-humanize-study/1 (bulk account-status check for a rating study)'
# lichess ids: letters, digits, _ and -, up to 30. Old accounts may START with _ or - (the 2017-04
# pilot had three), so the newer starts-with-a-letter rule must not be applied here.
ID_RE = re.compile(r'^[a-z0-9_-]{1,30}$')
DAY, TEN_MIN = 86400, 600


def load_state(path):
    done, log = {}, []
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) != 3:
                    continue                     # a line cut by a hard kill: that user is re-asked
                name, status, t = parts
                if status == 'invalid':
                    continue                     # re-validated every run, so a rule fix reaches them
                done[name] = status
                log.append(float(t))
    log.sort()
    return done, log


def window_counts(log, now):
    """log is sorted ascending (requests are appended in time order)."""
    return len(log) - bisect.bisect_left(log, now - DAY), len(log) - bisect.bisect_left(log, now - TEN_MIN)


def wait_needed(log, now, n, per10, perday):
    """Seconds until sending n more users keeps both windows within their limits."""
    wait = 0.0
    for span, limit in ((DAY, perday), (TEN_MIN, per10)):
        start = bisect.bisect_left(log, now - span)
        over = len(log) - start + n - limit
        if over > 0:   # the oldest `over` entries must age out of the window first
            wait = max(wait, log[start + over - 1] + span - now)
    return max(0.0, wait)


def eta_seconds(log, now, remaining, batch, perday, interval):
    """Approximate: today's allowance at the paced rate, then one 24 h window per further
    `perday` users. The daily limit dominates any run over ~120k users."""
    if remaining <= 0:
        return 0.0
    day, _ = window_counts(log, now)
    avail = max(0, perday - day)
    if remaining <= avail:
        return remaining / batch * interval
    rest = remaining - avail
    days = -(-rest // perday)
    start = bisect.bisect_left(log, now - DAY)
    frees_at = (log[start] + DAY - now) if start < len(log) else 0.0
    last_chunk = rest - (days - 1) * perday
    return max(avail / batch * interval, frees_at) + (days - 1) * DAY + last_chunk / batch * interval


def fetch(ids, timeout):
    req = urllib.request.Request(URL, data=','.join(ids).encode(), method='POST',
                                 headers={'Content-Type': 'text/plain', 'Accept': 'application/json',
                                          'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def verdict(u):
    tos, closed = bool(u.get('tosViolation')), bool(u.get('disabled'))
    return 'closed_tos' if (tos and closed) else 'closed' if closed else 'tos' if tos else 'ok'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--names', action='append', required=True, help='names file (one per line); repeatable')
    ap.add_argument('--state', required=True, help='append-only TSV of verdicts; shared across months')
    ap.add_argument('--batch', type=int, default=300, help='ids per request (API maximum 300)')
    ap.add_argument('--per-10min', type=int, default=8000, help='users per 10 minutes (documented limit)')
    ap.add_argument('--per-day', type=int, default=120000, help='users per 24 hours (documented limit)')
    ap.add_argument('--max-requests', type=int, default=0, help='stop after this many requests (pilots)')
    ap.add_argument('--raw-dump', default='', help='write each raw JSON answer to this .jsonl (pilot evidence)')
    ap.add_argument('--timeout', type=float, default=60)
    args = ap.parse_args()
    batch = max(1, min(300, args.batch))
    # Even spacing at the 10-minute limit: 300 users every 22.5 s is exactly 8,000 / 10 min, so the
    # window never fills and no burst is ever refused.
    interval = batch * TEN_MIN / args.per_10min

    wanted, seen = [], set()
    for path in args.names:
        with open(path) as f:
            for line in f:
                n = line.strip().lower()
                if n and n not in seen:
                    seen.add(n)
                    wanted.append(n)
    done, log = load_state(args.state)
    todo = [n for n in wanted if n not in done]
    invalid = [n for n in todo if not ID_RE.match(n)]
    todo = [n for n in todo if ID_RE.match(n)]
    os.makedirs(os.path.dirname(os.path.abspath(args.state)), exist_ok=True)
    st = open(args.state, 'a')
    now = time.time()
    for n in invalid:
        st.write(f'{n}\tinvalid\t{now:.0f}\n')
    st.flush()
    already = len(wanted) - len(todo) - len(invalid)
    print(f'accounts: {len(wanted):,} names, {already:,} already in the state file, {len(invalid):,} invalid, '
          f'{len(todo):,} to ask ({(len(todo) + batch - 1) // batch:,} requests)', file=sys.stderr)
    dump = open(args.raw_dump, 'a') if args.raw_dump else None

    prog = sc.Progress('accounts', total=len(todo), unit='users')
    counts = collections.Counter()
    sent = 0
    requests = 0
    last_send = max(log) if log else 0.0
    backoff = 60.0
    i = 0
    timings = []
    try:
        while i < len(todo):
            if args.max_requests and requests >= args.max_requests:
                break
            ids = todo[i:i + batch]
            now = time.time()
            w = max(wait_needed(log, now, len(ids), args.per_10min, args.per_day), last_send + interval - now)
            while w > 0:
                eta = eta_seconds(log, time.time(), len(todo) - i, batch, args.per_day, interval)
                day, _ = window_counts(log, time.time())
                stage = 'waiting for the 24 h window' if w > interval + 1 else 'pacing'
                prog.update(sent, f'{stage}: {sc.fmt_dur(w)} | last 24 h {day:,}/{args.per_day:,} | {dict(counts)}',
                            frac=i / max(1, len(todo)), eta=eta)
                time.sleep(min(w, 5.0))
                w = max(wait_needed(log, time.time(), len(ids), args.per_10min, args.per_day),
                        last_send + interval - time.time())
            t_req = time.time()
            try:
                users = fetch(ids, args.timeout)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    # lichess: "wait a full minute" after a 429; doubled while it persists, 15 min cap
                    sys.stderr.write(f'\n[accounts] HTTP 429, waiting {backoff:.0f} s\n')
                    time.sleep(backoff)
                    backoff = min(900.0, backoff * 2)
                    last_send = time.time()
                    continue
                sys.stderr.write(f'\n[accounts] HTTP {e.code}; retrying in 30 s\n')
                time.sleep(30)
                continue
            except (urllib.error.URLError, OSError, ValueError) as e:
                sys.stderr.write(f'\n[accounts] request failed ({e}); retrying in 30 s\n')
                time.sleep(30)
                continue
            backoff = 60.0
            t_done = time.time()
            timings.append(t_done - t_req)
            last_send = t_req
            requests += 1
            if dump:
                dump.write(json.dumps({'asked': ids, 'answer': users}) + '\n')
                dump.flush()
            got = {u.get('id', '').lower(): verdict(u) for u in users if isinstance(u, dict)}
            for n in ids:
                s = got.get(n, 'missing')
                counts[s] += 1
                st.write(f'{n}\t{s}\t{t_req:.0f}\n')
                log.append(t_req)
            st.flush()
            os.fsync(st.fileno())
            sent += len(ids)
            i += len(ids)
            eta = eta_seconds(log, time.time(), len(todo) - i, batch, args.per_day, interval)
            prog.update(sent, f'{requests} requests, {timings[-1]:.2f} s last | {dict(counts)}',
                        frac=i / max(1, len(todo)), eta=eta)
    except KeyboardInterrupt:
        st.close()
        prog.done(sent, f'INTERRUPTED after {requests} requests; state saved, re-run the same command to continue '
                        f'| {dict(counts)}', frac=i / max(1, len(todo)))
        sys.exit(130)
    st.close()
    prog.done(sent, f'{requests} requests | {dict(counts)}', frac=i / max(1, len(todo)))
    left = len(todo) - i
    mean_t = sum(timings) / len(timings) if timings else 0
    print(f'accounts: {requests} requests, {sent:,} users, mean request {mean_t:.2f} s; verdicts {dict(counts)}; '
          f'{left:,} left' + (' (stopped by --max-requests)' if left and args.max_requests else ''))


if __name__ == '__main__':
    main()
