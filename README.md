![Mephisto](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

**Mephisto** is a browser extension for real‑time **chess analysis** and **automated play** on **Chess.com**,
**Lichess**, **BlitzTactics**, and **TakeTakeTake**. It reads the position straight off the page, runs a local
**Stockfish** (NNUE) or **Fairy‑Stockfish** engine entirely in your browser — no server, no account — and draws the
**best move** on the board, or plays it for you with timing and move choices that can be tuned to look completely
human.

> Chess bot · best‑move finder · Stockfish in the browser · auto‑move · board scanner · eval bar · Chess960 &
> variants · move analysis for Chess.com, Lichess, BlitzTactics and TakeTakeTake.

Click Mephisto's toolbar icon to toggle its floating analysis panel directly on the page. The panel drags anywhere
by its title bar, closes with the ✕, and — unlike a classic extension popup — stays open while you click and play,
so analysis and autoplay keep running for the whole game.

---

## ⭐ Why this fork?

This is an **actively maintained** continuation of the original
[Mephisto by Alex Petrusca](https://github.com/AlexPetrusca/Mephisto). Installed from upstream today it detects
nothing — the 2026 Chess.com and Lichess redesigns broke every scraper. This fork **revives it on today's sites and
goes far beyond.** Everything the original did still works here; the table shows what's new.

| Capability | Original | **This fork** |
|---|:---:|:---:|
| Best‑move analysis + board arrows (Chess.com, Lichess) | ✅ | ✅ |
| Local Stockfish engine in the browser, no server | ✅ | ✅ |
| Autoplay · Multiple lines · "Hand & Brain" · Remote engine | ✅ | ✅ |
| **Works on the 2026 Chess.com / Lichess sites** | ❌ broken | ✅ |
| **Modern engines** — Stockfish dev / 18 / 18‑Small NNUE | ❌ | ✅ |
| **Elo strength cap** (engine‑aware slider) | ❌ | ✅ |
| **Humanize** — human move mix, timing & reflex recaptures | ❌ | ✅ |
| **Clock Mode & Mirror Time** management | ❌ | ✅ |
| **Safe Premove** (+ human‑reflex gate) | ❌ | ✅ |
| **Help Mode** — draw arrows on the real board | ❌ | ✅ |
| **On‑board eval bar** with live search depth | ❌ | ✅ |
| **Chess.com variants** (11) — detect · analyze · autoplay | ❌ | ✅ |
| **TakeTakeTake** (WebGPU canvas board, incl. online games) | ❌ | ✅ |
| **Chess960** on every mainline Stockfish | ❌ | ✅ |
| Event‑driven detection · floating resizable panel · engine crash‑recovery | ❌ | ✅ |

Issues and pull requests are watched and fixed — this fork is **updated and maintained**.

---

## Install (load unpacked)

This build is distributed as an unpacked extension, not through the Chrome/Firefox stores.

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top‑right).
4. Click **Load unpacked** and select the repository folder.
5. Pin Mephisto for quick access: click the puzzle icon right of the address bar and pin "Mephisto Chess Extension".

To pick up a code change: reload the extension on `chrome://extensions`, then reload the game tab.

---

## The panel

- **Floating & draggable** — drag by the title bar, place it anywhere over the board; it never blocks the game.
- **Evaluation & lines** — the score (White‑relative) plus the best line and, optionally, alternative lines and a
  threat line, all as arrows on the board.
- **Quick Settings** — every setting is editable inline: engine, Elo cap, variant, search time, threads, memory,
  number of lines, and all timing/mode toggles. Changes apply on the next move (engine changes reload the panel).
- **Re‑detect (↻)** — rescan the page and restart analysis, e.g. after a new game loads without a full page reload.
- **Analysis board** — open the current position on Lichess's analysis board in one click.

---

## Engines

Everything runs locally in your browser via WebAssembly — no server, no account, nothing leaves your machine.

| Engine | Notes |
| --- | --- |
| **Stockfish dev NNUE** | Latest development build, neural‑net eval. Default. |
| **Stockfish 18 NNUE** | Full dual‑net build (the large net ships split into chunks and is stitched at load). |
| **Stockfish 18 Small NNUE** | Smaller net — lighter download, still very strong. |
| **Stockfish 11 HCE** | Classical hand‑crafted eval (no NNUE); light and fast. |
| **Fairy‑Stockfish 14 NNUE** | Required for the chess **variants** below (each variant has its own net). |
| **Remote Engine** | Talk to an engine running outside the browser over a small local bridge, for when you want more power than WASM allows. |

Illegal scraped positions (missing king, wrong side in check, back‑rank pawns) are blocked before they can crash the
engine, and a crashed engine auto‑restarts (capped at 3 attempts).

### Strength cap (Elo)

Limit any Stockfish/Fairy engine to a target **Elo** with an engine‑aware slider. The stops follow each engine's
real `UCI_Elo` range (Stockfish dev/18: 1320–3190, Stockfish 11: 1350–2850, Fairy: 500–2850). Both ends of the
slider mean **full strength** (no cap): *Off* on the far left, *"max+"* on the far right. Sent as
`UCI_LimitStrength` + `UCI_Elo`; values outside an engine's range are ignored by the engine, so the slider stays
within bounds automatically.

### Variants

Standard chess and **Chess960 / Fischer Random** work on every mainline Stockfish (via `UCI_Chess960`).
Fairy‑Stockfish ships its own NNUE net per variant and additionally plays:

- **Lichess** — Crazyhouse, King of the Hill, Three‑Check, Antichess, Atomic, Horde, Racing Kings (all of Lichess's variants).
- **Chess.com** — the above plus **Duck, Minihouse, Seirawan (S‑Chess), and Chaturanga** (Giveaway maps to Antichess).

The **↻** button next to the variant selector detects the variant from the current game and switches to the right
engine automatically. Each variant's net is bundled, so nothing extra to download.

---

## ⚡ Full-power native engines (optional)

**You don't need this.** The bundled WASM engines above work out of the box with zero setup. But WASM
is sandboxed — it can't use all your CPU cores or much RAM, so it runs maybe **5–70× slower** than a
native engine. If you want *maximum* strength and speed, you can point Mephisto at a **native**
Stockfish / Fairy-Stockfish installed on your machine. Chrome then **auto-launches** it for you — there
is **no server to run**. This is entirely opt-in and doesn't affect the default WASM engines.

When set up, two extra engines appear in the dropdown — **Stockfish (local)** and
**Fairy-Stockfish (local)** — sitting next to their **WASM** counterparts so you can switch freely.
They run at all cores + up to 2 GB hash (both follow your Threads/Hash sliders). Switching engines
shuts the previous local engine down so the one you pick gets the whole CPU.

### What you need
1. A native **Stockfish** binary (and optionally **Fairy-Stockfish** for variants).
2. **Python 3** with `python-chess`:  `python3 -m pip install chess`
3. Your **extension ID** (see below).

> **Extension ID:** open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`),
> turn on **Developer mode**, and copy the long id shown under *Mephisto*.
> ⚠️ An unpacked extension's id **changes when you reload it** — if native engines stop working after a
> reload, just re-run the install command with the new id.

### macOS
```bash
brew install stockfish fairy-stockfish        # or download the Apple-Silicon build from stockfishchess.org
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
(A binary downloaded from the web is quarantined by Gatekeeper — the installer clears that for its copy.
If you point at one yourself, `chmod +x` it and, if macOS blocks it, `xattr -d com.apple.quarantine <path>`.)

### Linux
```bash
sudo apt install stockfish          # Debian/Ubuntu; or your distro's package / a release binary
python3 -m pip install chess
native-host/install-native.sh --ext-id YOUR_EXTENSION_ID
```
(Fairy-Stockfish: install `fairy-stockfish`, build it, or pass `--fairy /path/to/binary`.)

### Windows
The shell installer is macOS/Linux only; Windows native messaging needs a registry key, so it's a
manual (advanced) setup:
1. Install [Python](https://python.org) and run `pip install chess`; download `stockfish.exe`.
2. Copy `native-host/uci-native-host.py` somewhere stable and create `sf-native.path` next to it
   containing the full path to `stockfish.exe`.
3. Write a host manifest `com.sf_native.host.json` (underscores — Chrome rejects hyphens in host
   names) with `"path"` pointing at a `.bat` that runs `python <path>\uci-native-host.py`, and
   `"allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]`.
4. Add registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sf_native.host` = the manifest path.

(Prefer the bundled WASM engines on Windows unless you're comfortable with the registry.)

### Which binary?
Any native build unlocks full speed — the choice only matters at the margin. Pick the one matching your
CPU: **Apple Silicon** build on M-series Macs; **AVX2** or **BMI2** on modern Intel/AMD. Difference
between native builds is small; the jump from WASM to *any* native build is huge.

### Browsers
The installer registers the host for every Chromium-family browser it finds — **Chrome, Brave, Edge,
Chromium, Vivaldi**. Use the matching `…://extensions` page to get the id. (Firefox isn't supported for
native engines.)

If a native engine ever shows *"native host unavailable"*, the binary or `python-chess` is missing, or the
id changed — re-run the install command.

---

## Analysis features

- **Multiple lines** — show the top 1–5 candidate moves (MultiPV), each drawn on the board with its evaluation.
- **Show computer evaluation** — display the numeric score / eval bar (turn off for a cleaner board).
- **Eval bar** — a chess.com‑style vertical bar beside the board, from your perspective, with the score inside it.
- **Threat analysis** — also show the opponent's strongest reply, so you can see what they're threatening.
- **Search time** — how long the engine thinks per move (also the ceiling for continuous analysis).
- **Threads / Memory** — tune engine strength vs. resource use.
- **"Hand & Brain" mode** — Mephisto plays the *Brain* (tells you which piece type to move); you play the *Hand*
  (choose the actual move).
- **Continuous analysis** — with Autoplay off, the engine keeps analyzing indefinitely instead of stopping after
  the search time.

---

## Automated play

- **Autoplay** — Mephisto plays the engine's move for you automatically.
- **Help Mode** — instead of autoplaying, all analysis arrows are mirrored onto the site's board while the engine
  keeps evaluating; you play the move yourself when ready. Overrides Autoplay while on.
- **Puzzle Mode** — optimizes for solving puzzles as fast as possible (Puzzle Rush / Puzzle Storm).

### Safe Premove

While the opponent is thinking, Mephisto certifies a reply to their **predicted** move (the reply must be identical
at depth 6, 9 and 10+). If they play exactly that move, the reply fires **instantly**; anything else falls back to a
normal search — a wrong guess costs nothing. When the reply could never be legal after any other opponent move
(forced moves and true recaptures), it's queued as a real site premove immediately, and an illegal premove is
auto‑cancelled so it can never fire in the wrong position.

### Humanize

Make automated play look like a real person instead of a flawless engine:

- **Move mix** — five tunable sliders control how often Mephisto plays the top move, the 2nd line, the 3rd line, a
  *mistake*, or a *blunder*. Second/third lines are only used when they're not much worse than best; mistakes are
  ~0.6–1.5 pawns worse, blunders ~1.5–4.5 — and never in already‑decided games or into a mate. Edits apply to the
  very next move.
- **Human timing** — quick on obvious moves and openings, long thinks in critical positions, and an **instant
  reflex** *only* for true recaptures (the opponent actually captured, and you take back on that square) and forced
  moves. Snapping off a piece that merely moved in to attack is **not** treated as a reflex — that used to look
  suspiciously fast.
- **Reflex‑aware premove** — with Humanize on, premoves fire instantly only for those same true recaptures / forced
  replies; everything else waits for a natural think time. (With Humanize off, premove keeps full speed.)
- **Coming‑move countdown** — the panel shows what kind of move is coming (top / 2nd / 3rd / mistake / blunder /
  instant) and counts down until it's played.

### Clock Mode & Mirror Time

Two ways to manage the clock, both of which also size the engine's search to the time they intend to spend (so the
wait becomes a deeper move instead of idle time):

- **Clock Mode** — reads the game clock off the page and budgets each move to it (roughly time/30 plus 60% of the
  increment), playing near‑instantly when short on time.
- **Mirror Time** — paces to the *opponent* instead: spends what they spent on their last move minus 10%, staying
  just ahead on the clock (with extra haste when behind), and falls back to the Clock Mode budget when their spend
  is unknown.

**Priority when several are on** — *Time:* Mirror ▸ Clock ▸ Humanize ▸ Search Time (the first one enabled sets the
duration; recaptures & forced moves stay instant). *Move:* Humanize picks which move; otherwise the engine's best.
Each toggle's tooltip states this inline.

---

## Supported sites & modes

| Site | Analysis | Bot play / Autoplay | Premove | Puzzles | Online play | Variants |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Chess.com** | ✅ | ✅ incl. Play Bots | ✅ | ✅ Puzzle Rush / Storm | ✅ | ✅ 3‑Check, King of the Hill, Crazyhouse, Antichess, Atomic, Horde, Racing Kings — plus Chess960 |
| **Lichess** | ✅ | ✅ incl. AI & "From Position" | ✅ | ✅ Puzzle Storm | ✅ live & correspondence | ✅ Chess960 |
| **TakeTakeTake** | ✅ | ✅ bot games | ✅ | — | ✅ Lichess‑backed | — |
| **BlitzTactics** | ✅ | ✅ | — | ✅ puzzle streams | — | — |

- **Analysis** — best move(s) drawn on the board, with the eval bar and (optionally) alternative & threat lines.
- **Bot play / Autoplay** — Mephisto plays the engine's move for you, including against the site's computer bots.
- **Online play** — live games against other people; **Puzzles** — Puzzle Mode optimizes for solving speed.
- **Variants** — variant games auto‑detect and switch to Fairy‑Stockfish; Chess960 runs on any mainline Stockfish.

---

## Roadmap

No schedule — added whenever I feel like it.

- [ ] **lc0 (Leela Chess Zero)** — engine support running in the browser.
- [ ] **Maia NNUE** — human-like move prediction as a selectable engine.
- [ ] **Board from a screenshot** — capture any board shown online, render it in the popup, evaluate
      it, and make the board **playable** — with a button to **reset back to the current (live) move**.
- [ ] **Native-engine health badge** — a live status dot by the engine picker showing whether the local
      native host is connected, not installed, or crashed, so you always know if you're really on the
      full-power binary and not silently on WASM.
- [ ] **Smart default threads** — first native launch defaults threads to `cores − 1` from
      `hardwareConcurrency`, so local engines run near full power out of the box without touching the slider.
- [ ] **Ponder / background analysis** — keep analyzing on the opponent's turn (otherwise-idle CPU) so the
      reply is near-instant once it's your move. Native engines only.
- [ ] **NPS / depth sparkline** — a small history strip under the live NPS readout showing the last ~20
      samples, so you can watch an engine ramp or throttle instead of one flickering number.

**More variant coverage** (as engines allow):

- [ ] **Setup Chess** (chess.com) — custom starting position; scrape the placed pieces into a FEN and analyze from there.
- [ ] **Spell Chess** (chess.com) — piece "spells" change legality mid‑game; needs a custom rules layer on top of Fairy‑Stockfish.
- [ ] **Fog of War / Dark chess** — hidden‑information variant; only the visible squares are known, so analysis must
      reason over the fog (best‑effort, not perfect).
- [ ] **Duck Chess autoplay polish** — net is bundled; finish the duck‑placement move handling so it fully autoplays.
- [ ] **4‑player variants** (4 Player Chess, Chaturaji, 4P Giveaway, Self Partnering) — different board/turn model than
      chess.js; would need a separate 4‑player engine + board reader. Long shot.
- [ ] **Bughouse / Doubles** and **Chess With Checkers** — two‑board / mixed‑ruleset games; out of scope for a single
      Fairy‑Stockfish instance, tracked here for completeness.
- [ ] More coming.

---

## Contributing

Ideas, bug reports, and PRs are all welcome — open an issue or a pull request.
