#!/usr/bin/env python3
# Fetch the Fairy-Stockfish nets the native host needs into its runtime net folder.
#
#   fetch-fairy-nets.py <engine-assets.json> <net-dir>
#
# The slim zip (3.1.316 on) carries no nets: the extension downloads them into the Cache API, where a
# native host cannot see them. Without this the native Fairy got an empty folder, found no EvalFile
# for any variant and ran on its classical eval, much weaker than the WASM Fairy it replaced, with
# nothing saying so. Each net comes from the assets release the manifest names and must match the
# manifest's size and SHA-256, the same check the extension makes. Nets already in <net-dir> with the
# right size are kept, so a re-run (or a full-zip install, where install copied them) fetches nothing.
# A net the manifest no longer names is deleted: the host takes the first <variant>-*.nnue, and an old
# one left beside its replacement could sort first.
import hashlib, json, os, sys, time, urllib.request

FAIRY_DIR = 'lib/engine/fairy-stockfish-14/nnue'

# ONLY THE NETS THE NATIVE FAIRY CAN USE (audit 3.1.329 NATIVE-7). The host builds each position with
# chess.variant.find_variant(<variant>), and python-chess has no board for duck, chaturanga, minihouse
# or seirawan, so the panel refuses those four for the native Fairy before any request (MPH-E08,
# NATIVE_BOARDLESS_VARIANTS in popup.js mirrors this). Their nets were 195 MB of the 494 MB fetch.
# Asked of python-chess itself, the same call the host makes, so the two cannot disagree; without
# python-chess (the host could not run either) every net is kept.
try:
    import chess.variant
except ImportError:
    chess = None

def native_usable(name):
    prefix = name.split('-', 1)[0]      # <variant>-<hash>.nnue; nn-* is standard chess and Chess960
    if prefix == 'nn' or chess is None:
        return True
    try:
        chess.variant.find_variant(prefix)
        return True
    except ValueError:
        return False

def bar(done, total, start, label):
    el = max(time.time() - start, 1e-6)
    rate = done / el
    eta = (total - done) / rate if rate > 0 else 0
    return (f'{label} {done / 1e6:6.1f}/{total / 1e6:.1f} MB {100 * done / total:5.1f}% '
            f'{rate / 1e6:5.1f} MB/s elapsed {el:4.0f}s ETA {eta:4.0f}s')

def main():
    manifest, dest = sys.argv[1], sys.argv[2]
    m = json.load(open(manifest, encoding='utf-8'))
    fairy = {n: e for n, e in m['files'].items() if e['dir'] == FAIRY_DIR}
    nets = {n: e for n, e in fairy.items() if native_usable(n)}
    unused = sorted(n.split('-', 1)[0] for n in fairy if n not in nets)
    if unused:
        print(f'   Fairy nets: skipping {", ".join(unused)} (the native Fairy cannot play those variants)')
    for f in os.listdir(dest):
        if f.endswith('.nnue') and f not in nets:
            os.remove(os.path.join(dest, f))
            why = 'a variant the native Fairy cannot play' if f in fairy else 'no longer in the manifest'
            print(f'   Fairy nets: removed {f} ({why})')
    need = {n: e for n, e in nets.items()
            if not (os.path.isfile(os.path.join(dest, n)) and os.path.getsize(os.path.join(dest, n)) == e['size'])}
    if not need:
        print(f'   Fairy nets: all {len(nets)} present')
        return 0
    total = sum(e['size'] for e in need.values())
    print(f'   Fairy nets: fetching {len(need)} of {len(nets)} ({total / 1e6:.0f} MB) from the assets release')
    tty = sys.stdout.isatty()
    done, start, failed = 0, time.time(), []
    for i, (name, e) in enumerate(sorted(need.items()), 1):
        url = f"https://github.com/{m['repo']}/releases/download/{e['tag']}/{name}"
        part = os.path.join(dest, name + '.part')
        label = f'   net {i}/{len(need)}'
        h, got, last = hashlib.sha256(), 0, 0.0
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(part, 'wb') as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk); h.update(chunk); got += len(chunk)
                    now = time.time()
                    if tty:
                        print('\r' + bar(done + got, total, start, label), end='', flush=True)
                    elif now - last > 10:   # piped: one plain line every 10 s, never silence
                        print(bar(done + got, total, start, label), flush=True); last = now
            if tty:
                print()
            if got != e['size'] or h.hexdigest() != e['sha256']:
                raise ValueError(f'size {got} / sha256 {h.hexdigest()[:12]} do not match the manifest')
            os.replace(part, os.path.join(dest, name))
        except Exception as ex:
            if tty:
                print()
            print(f'!! {name}: {ex}')
            failed.append(name)
            try: os.remove(part)
            except OSError: pass
        done += e['size']
    if failed:
        print(f'!! {len(failed)} Fairy net(s) missing -- those variants run without a net. Re-run the installer to retry.')
        return 1
    print(f'   Fairy nets: {len(need)} fetched and verified in {time.time() - start:.0f}s')
    return 0

if __name__ == '__main__':
    sys.exit(main())
