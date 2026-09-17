# Archived release notes

These releases were removed from the Releases page to bring the repository's asset storage
back under control: 164 releases each carrying a ~660 MB full install came to **82.3 GB**, and
uploads had started failing. **Their notes are kept here in full, and their git tags are still
in the repository**, so every version below can still be checked out and rebuilt - only the
prebuilt zips are gone.

Removed v3.1.57, v3.1.60, v3.1.74, v3.1.83, v3.1.85, v3.1.86, v3.1.87, v3.1.88, v3.1.89, v3.1.94, v3.1.96, v3.1.97, v3.1.98, v3.1.99, v3.1.100, v3.1.101, v3.1.102, v3.1.104, v3.1.128, v3.1.130.

---

## Mephisto 3.1.57 — unpacked extension (load in Chrome)

*Tagged v3.1.57 on 2026-07-15. Prebuilt zips removed (396 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.57` folder).

### New since 3.1.56
- **Win/Draw/Loss line** under the score — `White 50.0% | Draw 30.0% | Black 20.0%`, straight from the engine's `UCI_ShowWDL` (modern Stockfish, WASM + native). Shown from your own side first, one decimal. Blank on engines that don't report WDL.
- **Panel reordered** — lines now sit **below** the score/depth, with the WDL line in between; panel a touch taller so nothing clips.
- Roadmap trimmed to plain bullet points.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.56...v3.1.57

---

## Mephisto 3.1.60 — unpacked extension (load in Chrome)

*Tagged v3.1.60 on 2026-07-15. Prebuilt zips removed (396 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.60` folder).

### New since 3.1.59
- **Panel Style toggle** (Settings → General → **Panel Style**) — choose:
  - **Floating panel** (default) — the draggable window over the board.
  - **Toolbar popup** — the classic browser bubble; renders in the browser chrome with **zero page footprint** (the *safer* mode). Same features either way.
- **Per-session random probe channels** — the MAIN-world probes (TakeTakeTake, ChessBase) now use a fresh random event channel each page load instead of any fixed name.
- Adds the (silent, ubiquitous) `storage` permission for the Panel Style setting.

See the README's **Page footprint** section for how to switch to the safe mode.

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.59...v3.1.60

---

## Mephisto 3.1.74 — unpacked extension (load in Chrome)

*Tagged v3.1.74 on 2026-07-16. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.74` folder).

### Fixed since 3.1.73

- **Copy PGN button placement** — the new button had no positioning, so it appeared floating above the panel and pushed the board down, knocking the move/threat **arrows out of alignment** with the squares. It now sits at the bottom, right next to Copy FEN, and the arrows line up again.
- **The two copy buttons are now labelled `FEN` and `PGN`** instead of the small look-alike glyphs.
- Copy PGN also picks up the dark-panel styling it was missing (it was showing as a teal button among the dark ones).

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.73...v3.1.74

---

## Mephisto 3.1.83 — unpacked extension (load in Chrome)

*Tagged v3.1.83 on 2026-07-17. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.83` folder).

### Docs since 3.1.82

Text only — no behaviour change.

The README and the in-app **Humanize Move Mix** tooltip still said the wider engine search was triggered only by Inaccuracy/Mistake/Blunder. Since 3.1.82 it's triggered by **any** category worse than the near-best (third line and below). Both now say so — a pure top-plus-second mix keeps the cheaper search.

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.82...v3.1.83

---

## Mephisto 3.1.85 — unpacked extension (load in Chrome)

*Tagged v3.1.85 on 2026-07-17. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.85` folder).

### New since 3.1.84

- **NPS / depth sparkline** — two tiny live line charts under the NPS text: search **depth** climbing (blue) and **speed** ramping (green), redrawn as the engine streams and reset each move, so you can watch the current search grow. Hidden in compact.

- **Better self-test icon** — the previous 🩺 emoji showed as an empty box in many panel fonts. It's now an inline-drawn **heartbeat/pulse line** that renders identically everywhere.

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.84...v3.1.85

---

## Mephisto 3.1.86 — unpacked extension (load in Chrome)

*Tagged v3.1.86 on 2026-07-17. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.86` folder).

### Fixed since 3.1.85

- **Settings toggles stack vertically now.** The mode switches (Autoplay, Premove, … Manual Mode, Opponent Mistake Alert, …) were laid out in one long horizontal row that ran off the page and needed sideways scrolling. They're now listed one below another. The side-by-side input pairs (search time / poll interval, threads / memory) are unchanged.

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.85...v3.1.86

---

## Mephisto 3.1.87 — unpacked extension (load in Chrome)

*Tagged v3.1.87 on 2026-07-17. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.87` folder).

### Fixed since 3.1.86

- **Manual Mode now actually plays the move.** It never fired because the move-execution path drops any move when Autoplay is off — and Manual Mode is meant to be used *with* Autoplay off. The keypress-triggered move is now exempt from that check (it's your press, not an auto-fire), so it plays. This is why the other hotkeys worked but Manual Mode's didn't.

- **Opponent Mistake Alert:** the toast is **bigger**, stays on screen **~3.5 seconds**, and now shows the opponent's move in **SAN and UCI** (e.g. `Nf6 · g8f6`) under the label.

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.86...v3.1.87

---

## Mephisto 3.1.88 — unpacked extension (load in Chrome)

*Tagged v3.1.88 on 2026-07-17. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.88` folder).

### Changed since 3.1.87

- **Removed the NPS / depth sparkline.**
- **Hotkey defaults are now single letters** — Autoplay **A**, Premove **P**, Help **H**, Humanize **U**, Clock **C**, Mirror **M**, Manual **N**, Eval Bar **E**, Puzzle **Z**, Copy FEN **F**, Copy PGN **G**, Re-detect **R**; play move stays **Space**. (Rebind any of them under Settings → Hotkeys.)
- **Each toggle now shows its hotkey next to it** in the panel, e.g. "Autoplay (A)".

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.87...v3.1.88

---

## Mephisto 3.1.89 — unpacked extension (load in Chrome)

*Tagged v3.1.89 on 2026-07-18. Prebuilt zips removed (395 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.89` folder).

### New since 3.1.88

Security hardening from the issue #36 report (thanks @IazLur):

- **Authenticated tab targeting** — the background's debugger-click handler now uses the Chrome-authenticated sender tab instead of a message-supplied tab id.
- **URL pin** — `openUrl` only opens the lichess analysis board, the one destination the panel ever requests.
- **Backend origin guards** — `remote-engine.py` and `mephisto-clicker.py` bind explicitly to `127.0.0.1` and reject requests whose `Origin` is neither an extension context nor one of the sites the panel runs on; the clicker also clamps click coordinates to the screen.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.88...v3.1.89

---

## Mephisto 3.1.94 — unpacked extension (load in Chrome)

*Tagged v3.1.94 on 2026-07-20. Prebuilt zips removed (422 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.94` folder).

### New since 3.1.93

- **Maia 2200** — a tenth rating band in **Engine → Maia**. This is [@CallOn84](https://github.com/CallOn84/LeelaNets)'s Maia-architecture net, extending the original CSSLab Maia-1 family (1100–1900) to a higher rating. Runs in the browser as a single forward pass, same as the others; verified to reproduce the lc0 reference move 100% across full games.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.93...v3.1.94

---

## Mephisto 3.1.96 — unpacked extension (load in Chrome)

*Tagged v3.1.96 on 2026-07-20. Prebuilt zips removed (503 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.96` folder).

### New since 3.1.95

- **Maia-3 upgraded to the 23M model.** The default Maia-3 net is now the 23M-parameter variant (was 5M) — measurably more human-accurate: ~60% move-match to real human play vs ~57% for the 5M net, measured on rated games. Everything else about Maia-3 is unchanged (one model, live 600–2600 Elo slider). Cost is a bigger download and ~10 ms/move (still imperceptible).

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.95...v3.1.96

---

## Mephisto 3.1.97 — unpacked extension (load in Chrome)

*Tagged v3.1.97 on 2026-07-20. Prebuilt zips removed (503 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.97` folder).

### New since 3.1.96

- **Maia now draws board arrows and supports Multi Lines.** The Maia (1100–2200) engine emitted its move without the `multipv` field the panel needs, so it drew no Help-Mode arrows and the Multi Lines slider did nothing. It now ranks every legal move by the net's policy and emits proper multi-PV lines, so Help Mode draws arrows and Multi Lines shows the top human-likely candidates — just like the Stockfish engines. (Maia-3 already had this.) The move it plays is unchanged.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.96...v3.1.97

---

## Mephisto 3.1.98 — unpacked extension (load in Chrome)

*Tagged v3.1.98 on 2026-07-20. Prebuilt zips removed (503 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.98` folder).

### New since 3.1.97

- **Fixed Maia Multi Lines showing only one line/arrow.** Both Maia engines emitted their multi-PV lines in the wrong order, so no matter how high you set Multi Lines, only the top move showed. They now emit best-line-first (like Stockfish), so Multi Lines shows the full set of top human-likely candidates as arrows on the board.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.97...v3.1.98

---

## Mephisto 3.1.99 — unpacked extension (load in Chrome)

*Tagged v3.1.99 on 2026-07-20. Prebuilt zips removed (503 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.99` folder).

### New since 3.1.98

- **Fixed intermittent promotion failures on Lichess.** Autoplay looked for the promotion picker the instant the pawn reached the last rank, but Lichess renders the picker a moment later — so on a slow render the piece was never clicked and the pawn stuck on the 8th rank. It now waits for the picker to appear before choosing the piece.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.98...v3.1.99

---

## Mephisto 3.1.100 — unpacked extension (load in Chrome)

*Tagged v3.1.100 on 2026-07-20. Prebuilt zips removed (503 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.100` folder).

### New since 3.1.99

- **License compliance & credits.** Added the license texts and attribution the project was missing. It bundles copyleft components — GPL-3.0 Stockfish / Fairy-Stockfish and their nets, the Maia-1 and Maia 2200 nets, and the **AGPL-3.0** Maia-3 model — so the **combined distribution is governed by AGPL-3.0**. New files: `LICENSING.md`, `THIRD-PARTY-NOTICES.md`, `licenses/GPL-3.0.txt`, `licenses/AGPL-3.0.txt`, and onnxruntime's `LICENSE` + `ThirdPartyNotices.txt`. No code or behaviour changes.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.99...v3.1.100

---

## Mephisto 3.1.101 — unpacked extension (load in Chrome)

*Tagged v3.1.101 on 2026-07-20. Prebuilt zips removed (503 MB).*

Load-unpacked Chrome build (unzip → chrome://extensions → Load unpacked → pick the `Mephisto-3.1.101` folder).

### New since 3.1.100

- **"(local)" engines are hidden when their host isn't installed.** The native Stockfish / Fairy "(local)" engines need the native-messaging host set up, but they used to appear in the engine dropdown regardless. Now the panel probes each native host on load and only lists the ones that actually respond — so a fresh install shows just the in-browser engines (Stockfish WASM, Maia, Maia-3) and Remote Engine. Install a native host and its "(local)" option appears automatically.

Reminder: this project is for analysis, puzzles, and play against engines — using it in rated games against humans violates the fair-play rules of chess sites.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.100...v3.1.101

---

## Mephisto 3.1.102 — unpacked extension (load in Chrome)

*Tagged v3.1.102 on 2026-07-20. Prebuilt zips removed (503 MB).*

## Pondering — use the opponent's think time

The panel already searches the opponent-to-move position while you wait (this feeds
Premove, Threat Analysis and Help Mode). This release makes that wait deliberate:

- **Opponent's turn drops to 1 thread by default** — waiting on the opponent is no
  longer a full-core burn. Your own move still searches at the full configured thread count.
- **New "Pondering" toggle** (Settings → General, off by default) lifts the cap: with it
  on, the opponent's turn is searched at full threads and runs for their whole think, so a
  deeper reply is ready the instant they move. Pairs with Premove for instant answers.

The ponder search is abandoned the moment the position changes and its bestmove is
discarded, so it can never leak out as one of your moves.

**Install:** unzip and load the `Mephisto-3.1.102/` folder as an unpacked extension
(chrome://extensions → Developer mode → Load unpacked).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.101...v3.1.102

---

## Mephisto 3.1.104 — unpacked extension (load in Chrome)

*Tagged v3.1.104 on 2026-07-20. Prebuilt zips removed (503 MB).*

## "Pondering —" shown in the readout

While the Pondering feature is searching the opponent's move, the live best-move
line now reads:

> **Pondering — Black to play, best move is …**

instead of just "Black to play, …", so it's clear the engine is deliberately
spending the opponent's time rather than stalling on your move. Shown only when
the Pondering toggle is on and it's the opponent's turn; your own move is unchanged.

**Install:** unzip and load the `Mephisto-3.1.104/` folder as an unpacked extension
(chrome://extensions → Developer mode → Load unpacked).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.103...v3.1.104

---

## Mephisto 3.1.128 — unpacked extension (load in Chrome)

*Tagged v3.1.128 on 2026-07-25. Prebuilt zips removed (557 MB).*

The panel is back to its original height.

v3.1.126 made it taller to fit the settings column, but the tighter row spacing in that same change
was already enough on its own — the extra height just left dead space under the settings. Both
columns clear the original 672px: the board with five alternative lines ends above the button row,
and the settings fit with room to spare.

**Install:** unzip and load the `Mephisto-3.1.128/` folder as an unpacked extension
(chrome://extensions → Developer mode → Load unpacked).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.129...v3.1.128

---

## Mephisto 3.1.130 — unpacked extension (load in Chrome)

*Tagged v3.1.130 on 2026-07-25. Prebuilt zips removed (557 MB).*

**Multi Lines now draws an arrow for every line.**

It listed all five lines in the panel but drew a single arrow — on the panel board and, through Help
Mode, on the site's board too.

The arrow drawing only ran from the branch that handles the *first* line of a depth, and that branch
clears the line list before storing line one. So the arrows were always drawn with exactly one line
in hand, however many the engine had returned. The alternative lines arrived afterwards and only
refreshed the text list; they now redraw the arrows as well — on the in-browser, native and remote
engines alike.

Lines far worse than the best are still dropped, so a losing alternative doesn't get an arrow just
because it exists.

**Install:** unzip and load the `Mephisto-3.1.130/` folder as an unpacked extension
(chrome://extensions → Developer mode → Load unpacked).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.128...v3.1.130

---

---

## Second pass: releases nobody had downloaded

A further **37 releases whose assets had never been downloaded once** (checked against the
GitHub API's `download_count`, 2026-09-17) were removed, freeing **18.7 GB**. Anything with even
one download was left alone, as was `models-v1`, which the extension itself fetches model weights
from at runtime. As above: **notes verbatim below, git tags untouched.**

Removed v3.1.41, v3.1.46, v3.1.47, v3.1.55, v3.1.56, v3.1.59, v3.1.70, v3.1.79, v3.1.135, v3.1.136, v3.1.199, v3.1.202, v3.1.204, v3.1.242, v3.1.243, v3.1.245, v3.1.246, v3.1.247, v3.1.248, v3.1.249, v3.1.250, v3.1.251, v3.1.252, v3.1.253, v3.1.254, v3.1.255, v3.1.256, v3.1.257, v3.1.259, v3.1.261, v3.1.262, v3.1.263, v3.1.264, v3.1.268, v3.1.269, v3.1.270, v3.1.272.

---

## Mephisto 3.1.41 — unpacked extension (load in Chrome)

*Tagged v3.1.41 on 2026-07-14. Prebuilt zips removed (313 MB), 0 downloads.*

Mephisto Chess Extension — unpacked build (v3.1.41), ready to load in Chrome.

**Install (Chrome / Edge / Brave):**
1. Download `mephisto-3.1.41.zip` below and unzip it.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped **Mephisto-3.1.41** folder (the one containing `manifest.json`).
5. Open lichess.org, chess.com, or taketaketake.com and click the Mephisto toolbar icon.

**What's included:** the full extension with all bundled engines (Stockfish dev / 18 / 18-small / 11-HCE, Fairy-Stockfish for variants) — no server or setup needed.

**Highlights in this build:** floating resizable panel, event-driven detection, Humanize (tunable move mix + move-category countdown), Clock Mode & Mirror Time with search-fills-the-pace, chess.com variants (auto-detected) and taketaketake.com support, resizable eval bar, recheck button.

~500 MB unzipped (chess neural nets are large). First engine load may take a few seconds.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v2.0.0-fix...v3.1.41

---

## Mephisto 3.1.46 — unpacked extension (load in Chrome)

*Tagged v3.1.46 on 2026-07-14. Prebuilt zips removed (313 MB), 0 downloads.*

Ready-to-load build of the actively-maintained Mephisto fork. No server, no setup — all engines are bundled.

## Install
1. Download **mephisto-3.1.46.zip** below and unzip it.
2. Open `chrome://extensions` (Chrome or any Chromium browser).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped **Mephisto-3.1.46** folder.
5. Pin it (puzzle icon → pin), then open a game on Chess.com / Lichess / BlitzTactics / TakeTakeTake.

## What's new since 3.1.41
- **Elo strength cap** — engine-aware slider; limit any Stockfish/Fairy engine to a target rating (both ends = full strength).
- **Humanize reflexes tightened** — instant replies now fire only for *true* recaptures and forced moves, not when a piece just moved in to attack.
- **Premove human-reflex gate** — with Humanize on, premoves fire instantly only for true recaptures / forced replies.
- **Timing-priority tooltips** — every timing toggle states the Time/Move priority inline; long tooltips wrap instead of clipping.
- **Chess960** on the troll/utility engines too; **Simulated Think Time** row removed from Quick Settings.
- **README** rewritten: comparison vs. upstream, and a supported-sites & modes matrix.

Bundled engines: Stockfish dev / 18 / 18-Small NNUE, Stockfish 11 HCE, Fairy-Stockfish 14 (+ all variant nets).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.41...v3.1.46

---

## Mephisto 3.1.47 — unpacked extension (load in Chrome)

*Tagged v3.1.47 on 2026-07-14. Prebuilt zips removed (313 MB), 0 downloads.*

Ready-to-load build of the actively-maintained Mephisto fork. No server, no setup — all engines bundled.

## Install
1. Download **mephisto-3.1.47.zip** below and unzip it.
2. Open `chrome://extensions` (Chrome or any Chromium browser).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped **Mephisto-3.1.47** folder.
5. Pin it, open a game on Chess.com / Lichess / BlitzTactics / TakeTakeTake.

## New in 3.1.47
- **Keeps autoplay running in the background.** Chrome throttles and eventually freezes a hidden tab, so switching to another fullscreen app used to stall autoplay. While **Autoplay is on**, the panel now plays a single inaudible tone that keeps the tab exempt — turn Autoplay on (one click arms it), then tab away and moves keep coming.

## Also since the last release
- **Elo strength cap** (engine-aware slider), **Humanize** true-recapture reflexes, **human-reflex premoves**, timing-priority tooltips, and a rewritten README with a supported-sites & modes matrix.

Bundled engines: Stockfish dev / 18 / 18-Small NNUE, Stockfish 11 HCE, Fairy-Stockfish 14 (+ all variant nets).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.46...v3.1.47

---

## Mephisto 3.1.55 — unpacked extension (load in Chrome)

*Tagged v3.1.55 on 2026-07-15. Prebuilt zips removed (313 MB), 0 downloads.*

Ready-to-load build. No server, no setup — all WASM engines bundled.

## Install
1. Download **mephisto-3.1.55.zip** below and unzip.
2. `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → pick the **Mephisto-3.1.55** folder.
4. Pin it, open a game on Chess.com / Lichess / BlitzTactics / TakeTakeTake.

## New since the last release
- **Full-power native engines (optional):** point at a native Stockfish/Fairy and Chrome auto-launches it — no server. Shown as "(local)" next to the WASM builds; ~5–70× faster. Setup guide in the README (`native-host/install-native.sh`).
- **Live NPS** under the best move (e.g. `1'019'100 NPS`).
- **Elo strength cap** slider.
- **Threads → 24, Hash → 2 GB** (WASM clamped to 512 MB; native follows the sliders).
- Switching engines shuts the previous local engine down so the CPU is free.
- Humanize true-recapture reflexes + reflex-aware premoves; background keep-alive for autoplay.

Bundled engines: Stockfish dev / 18 / 18-Small NNUE, Stockfish 11 HCE, Fairy-Stockfish 14 (+ variant nets).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.47...v3.1.55

---

## Mephisto 3.1.56 — unpacked extension (load in Chrome)

*Tagged v3.1.56 on 2026-07-15. Prebuilt zips removed (396 MB), 0 downloads.*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.56` folder).

### New since 3.1.55
- **4 more chess.com variants** now analyze + autoplay: **Duck, Minihouse, Seirawan (S-Chess), Chaturanga** — their Fairy-Stockfish NNUE nets are now bundled and wired into the variant picker + URL auto-detection. Chess.com variant coverage: **7 → 11**.
- All **Lichess variants** remain fully supported (Crazyhouse, King of the Hill, Three-Check, Antichess, Atomic, Horde, Racing Kings, Chess960).
- Roadmap expanded: more variant coverage (Setup Chess, Spell Chess, Fog of War, Duck autoplay polish, 4-player family), auto-download variant nets, graceful unsupported-variant state, From-Position FEN capture.

Optional **full-power native engines** (Stockfish / Fairy) are still available — see the README "Full-power native engines" section.

> Note: Duck/Minihouse/Seirawan/Chaturanga have Fairy nets but limited chess.js legality support, so autoplay on those four may still be rough (tracked on the roadmap).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.55...v3.1.56

---

## Mephisto 3.1.59 — unpacked extension (load in Chrome)

*Tagged v3.1.59 on 2026-07-15. Prebuilt zips removed (396 MB), 0 downloads.*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.59` folder).

### New since 3.1.57
- **ChessBase Tactics support** — `tactics.chessbase.com` Solve/Sprint now detect + analyze. The board is ChessBase's proprietary engine (no scrapeable FEN), so a MAIN-world probe reads the live position and feeds it to the panel.
- **Smaller page footprint** (see the README's "Page footprint" section):
  - Panel + its extension iframe now live in a **closed shadow root** under an attribute-less host — a page can't enumerate them or the iframe.
  - MAIN-world probes (TakeTakeTake, ChessBase) set **no `window.*` flag** and use neutral, de-branded event names.
  - Simulated moves click a **center-weighted** point in each square (not the exact pixel), via trusted input.
- WDL line shows from your own side with one decimal; native Stockfish/Fairy report WDL via `UCI_ShowWDL`.

> Reminder: using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.57...v3.1.59

---

## Mephisto 3.1.70 — unpacked extension (load in Chrome)

*Tagged v3.1.70 on 2026-07-16. Prebuilt zips removed (395 MB), 0 downloads.*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.70` folder).

### New since 3.1.60

**The floating panel no longer uses an in-page iframe.**
It used to be an extension-page `<iframe>` — and an iframe is a *browsing context*, so the page could still count it (`window.length`) and probe it cross-origin. A closed shadow root hides markup, **not** a frame's existence. That's now gone entirely:

- The panel renders **directly in the page's isolated world**, still inside a `mode:"closed"` shadow root.
- The WASM engine moved to an **offscreen document** — an invisible extension page that keeps the cross-origin isolation (`SharedArrayBuffer`) the threaded engines need, but that the page cannot see or count.
- **`web_accessible_resources` is removed.** Panel markup, CSS, board textures and piece images are now fetched extension-side and injected as inlined bytes / `data:` URIs — so **no `chrome-extension://` URL reaches the page or its Resource Timing**, and the extension id can't be read back.
- Settings moved to `chrome.storage.local` and are never written to the site's `localStorage`.
- Dropped jQuery, chessboard.js, Materialize's JS and its **icon font** (icons are Unicode now — no font request identifies the panel).

**Also new**

- **Human-shaped clicks** — autoplay no longer sends a lead deselect click on an empty square. A move was 3 clicks where a human plays 2.
- **Background Play** (Settings → General, **default off**) — moves only fire while the tab is focused and visible; a move due while you're tabbed away waits until you return.
- **Chess960 castling fixed** — board corruption and stalls in the bundled chess.js (wrong queenside rook destination; make/unmake assumed standard king/rook squares). King-takes-rook UCI (`e1h1`) accepted as a castle.
- **Antichess: promotion to a king** — `=K` was generated without the piece and rejected by the SAN parser, so the move was unplayable.
- **Fresh per-move timing** — Move/Think Time and the pacing modes are re-read before every move instead of at game start; a new game resets Mirror/Clock state (a rematch without a reload kept stale spend).
- **Copy FEN** button; the panel board repaints the moment a move is played; re-detect is no longer gated behind the poll interval.
- Fairy-Stockfish and SF dev/18/18-Small rebuilt.
- **README: a "Read this first — disclaimer & fair play" section** — what a Fair Play closure actually costs, and an honest account of why no client-side setting defeats server-side behavioural detection.

See the README's **Page footprint** section for the full list, and **Panel Style** if you want the zero-footprint toolbar popup (analysis only — Autoplay/Premove need the floating panel).

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.60...v3.1.70

---

## Mephisto 3.1.79 — unpacked extension (load in Chrome)

*Tagged v3.1.79 on 2026-07-17. Prebuilt zips removed (395 MB), 0 downloads.*

Load-unpacked Chrome build (unzip → chrome://extensions → Developer mode → Load unpacked → pick the `Mephisto-3.1.79` folder).

### Fixed since 3.1.78

**Humanize's Mistakes and Blunders sliders did nothing.** Set the mix to 25/30/40/5/0 and you'd still get a 97%-accuracy, 11-ACPL game with zero mistakes — an engine wearing a delay.

Every category is chosen from the engine's own list of candidate moves, and Humanize only asked for **3** of them. A strong engine's top 3 moves sit within about 0.4 pawns of each other — so "play a mistake" was asking for a move that was never on the list. Each time, the roll quietly fell back to the best move. The other 95% of rolls were top-3 moves capped at 0.6 pawns, which is exactly what 97% accuracy looks like. The mix was working; every option on the menu was an engine-best move.

- **Wider bands:** second/third lines are played when within **2 pawns** of the best (was 0.6), mistakes are **2–4 pawns** worse (was 0.6–1.5), blunders **4–6** (was 1.5–4.5). Nothing worse than 6 pawns is ever played — that's a hanging queen, not a human error.
- **The engine now searches 20 lines when Mistakes or Blunders are above 0**, so moves that bad are actually available to choose from. It only does this when you ask for them: a wide search costs real depth, so leaving both at 0 costs you nothing.
- **The sliders take effect on the very next move.** Previously the line count was fixed when the engine started, so switching mistakes on did nothing until something restarted the engine.

If you want play that doesn't look like an engine, the **Elo cap** is still the bigger lever — Humanize choosing among the top 3 moves of a 3200 engine is still a 3200 engine.

> Using an engine in a live game breaks most sites' fair-play rules — use analysis features responsibly. The detection that actually catches engine users is server-side and behavioural; nothing here defeats it.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.78...v3.1.79

---

## Mephisto 3.1.135 — unpacked extension (load in Chrome)

*Tagged v3.1.135 on 2026-07-28. Prebuilt zips removed (557 MB), 0 downloads.*

**Perfect endgames, an eval graph, and a panel that stops pretending to load.**

### Endgame tablebase
With **7 or fewer pieces** the position is *solved*, so there's nothing a search can be better at. Mephisto asks lichess's Syzygy tables for the answer and plays it over both the engine's pick and the opening book. The readout says what it found — `tablebase: win in 13`, `tablebase: draw` — so a substituted move is never silent.

Off by default: it sends the position to a third party, and that's your call rather than a default. The tables are hundreds of gigabytes, so a network probe is the only shippable form; it runs in the service worker, so the page makes no request, and it's never awaited — a slow lookup can't delay a move. Standard, atomic and antichess are served. Chess960 is deliberately excluded: a 7-man 960 position can still carry castling rights, and Syzygy has no notion of them.

**Tablebase** in Quick Settings (hotkey **T**), or Settings → General.

### Move confidence
The panel now says how much *better* the best move is than the second — `clearly best (+3.7)`, `+0.35 over #2`, `several equal`, or `only move`. "Only move" and "six moves are all fine" used to render identically. It reads the lines already on screen, so it costs no extra search, and stays quiet at **Multi Lines = 1** rather than widening one to manufacture a comparison.

### Eval history graph
The whole game as a curve under the board — white above the midline, black below — with the **opening / middlegame / endgame** boundaries marked. The divisions use the same conditions scalachess does (piece count, a sparse back rank, and a mixedness score over the board's 3×3 regions), so they land where Lichess puts them.

**Eval History** in Quick Settings (hotkey **Y**). Needs Eval Bar.

### Two guards you should never see
- Autoplay refuses a move that **drops a piece while the engine reads the position as fine**. Those two statements can't both be true of the same board — but they're routine when the panel has analysed a stale or mis-scraped one, which is how every scraping bug so far has presented. Real sacrifices still go through; a lost position is exempt.
- The board is **re-read immediately before every click** and the move dropped if the position moved on. The board and the analysis come from independent bits of DOM that a site doesn't update in one paint.

### Settings apply immediately
An options-page change now reaches an open panel straight away. It used to reach storage and stop there — the panel kept a snapshot from when it opened — so Background Play, Endgame Tablebase and Search Time all appeared to do nothing until a reload.

### The loading bar
Aspiration re-searches were being **dropped** at the native host rather than merely excluded from premove certification. Through every one of those windows the panel received nothing at all — no depth, no eval, no speed, no move — so on a long analysis it sat there looking stuck while the engine was working perfectly. They're forwarded and flagged now, and only the certification skips them.

### Also
- The opponent's turn is searched with **two threads** rather than one (never above your Threads setting) — premove certification needs depth 14, and one thread often didn't reach it.
- **Pondering now widens the candidate list on native engines**, where the width had silently done nothing.
- Turning **Autoplay** on keeps the deeper analysis already running instead of discarding it for a shorter one.
- A **first install** is offered a search time measured from the machine's own speed. Equal nodes travel between machines; equal milliseconds don't.

---

Unpacked extension — download, unzip, then `chrome://extensions` → Developer mode → **Load unpacked** → select the folder.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.134...v3.1.135

---

## Mephisto 3.1.136 — unpacked extension (load in Chrome)

*Tagged v3.1.136 on 2026-07-28. Prebuilt zips removed (557 MB), 0 downloads.*

**Removes the blunder guard — it was refusing winning sacrifices.**

The autoplay blunder guard added in 3.1.135 rested on a premise that doesn't hold. The idea was to catch the panel analysing a stale or mis-scraped position by looking for a contradiction: the engine reading the position as fine while the move it wants drops a piece. Those two things can't both be true, the reasoning went, unless the move was reasoned about somewhere else.

They can. In a genuine sacrifice the evaluation is healthy *precisely because* the material comes back, so the eval separates nothing — and a one-ply static exchange can't tell a sacrifice from a blunder either. The result was a guard that could only fire on the moves it was least entitled to veto. It refused `1…Rh1+ 2.Kxh1 Qxf2`, a rook given up to win the queen, and a knight sacrifice the engine was 3.66 ahead after. Both were the best move on the board.

The recovery path was broken too: on refusing a move it re-scraped, but the position hadn't changed, so the panel skipped re-analysis and the refused move was simply never played. Nothing recovered — it stalled.

**The board/engine mismatch guard stays.** That's the sound form of the same idea: it compares the board against the position that was actually analysed, rather than inferring a disagreement from how good the move looks.

### Background play: two latches

Both fit "works, then randomly stops, and stays stopped".

- The `moving` flag blocks every message the content script handles, and its only escape was a `setTimeout` — which in a hidden tab isn't an escape at all, since once the keep-alive tone lapses Chrome throttles timers to roughly one a minute. One move that failed to resolve latched the extension off. The next automove now notices a stale latch by elapsed time and breaks it itself, only after the budget that move was actually granted, so a long Humanize think is never cut short.
- Chrome can suspend the keep-alive audio context while a tab is hidden, and nothing revived it — the only caller was `visibilitychange`, which by definition doesn't fire while you're still away. It's re-asserted from the fallback poll now.

---

Unpacked extension — download, unzip, then `chrome://extensions` → Developer mode → **Load unpacked** → select the folder.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.135...v3.1.136

---

## Mephisto 3.1.199 — four-player chess (unpacked extension, load in Chrome)

*Tagged v3.1.199 on 2026-08-03. Prebuilt zips removed (558 MB), 0 downloads.*

**Four-player chess.** Chess.com's 4-player variant now analyses and plays, driven by [Tetrarch](https://github.com/IchNukeDichWeg/Tetrarch) — a purpose-built engine for 14×14 four-seat boards.

> **Teams mode only, for now.** Tetrarch does not search free-for-all.

Tetrarch needs a one-time install and is the only engine with nothing bundled behind it — the panel says so under the board if it isn't set up. See **Four-player chess** in the README for macOS and Linux steps. **Windows is not supported yet**: Tetrarch loads its C core as a `.so` with no fallback, so it needs a DLL build first.

### Four-player chess
- Board read straight to canonical FEN4 — a bypass lane, not the two-player path, since chess.js cannot represent 14×14 at all.
- Panel swaps in a 14×14 board with the corners cut, rotated so **you** sit at the bottom whichever seat you drew, with the suggested move drawn as an arrow.
- Evaluation normalised to **your team** (Red+Yellow vs Blue+Green) instead of flipping sign every seat.
- Autoplay, castling and en-passant rights derived per seat, and the turn taken from the move list on every scrape.
- Leaving a four-player page always switches back to Stockfish 18 WASM — Tetrarch plays nothing else.

### Fixes
- The first trusted click of a session raised Chrome's debugger infobar, which shrinks the viewport and re-lays-out the board — so the move that triggered it aimed at stale geometry and died half-played. The attach now happens ahead of the think delay, before any square is measured.
- A native host that is not installed says what to do instead of "Engine error".
- Settings and panel UI pass: steppers for Threads/Lines/Move time, one font per column, uniform control heights.

### Setup
Unpack and load as an unpacked extension at `chrome://extensions` with Developer mode on. Native engines and Tetrarch are optional — see the README.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.159...v3.1.199

---

## Mephisto 3.1.202 — four-player arrows, team eval-bar colours

*Tagged v3.1.202 on 2026-08-05. Prebuilt zips removed (558 MB), 0 downloads.*

**Four-player chess: arrows, eval-bar colours, and a header that lied.** Three things a 4PC game got wrong, all of them visible in a single screenshot.

### Help Mode drew nothing
`drawHintArrows` filtered moves with an 8×8 pattern, so a four-player move like `m8l8` was discarded before anything reached the board — the arrows were requested every update and thrown away. It now measures the 14×14 board and splits from/to by pattern, since a square there is two **or** three characters (`a1` … `n14`). The 8×8 path is unchanged.

### The eval bar stayed white and black
The 4PC path gated the panel's strip on the **Eval Bar** toggle — but that toggle governs the *page* overlay, and the normal path paints the strip unconditionally. With it off you got default colours instead of Team Red vs Team Blue. It always paints now.

### The header said "White to move"
Directly above a panel reading "Red to move". A White/Black switch means nothing with four seats, so it's hidden in a four-player game, the way the Elo and Variant rows already hide themselves — and restored on the way out.

Nothing outside four-player chess changed.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.201...v3.1.202

---

## Mephisto 3.1.204 — a 6 MB update download

*Tagged v3.1.204 on 2026-08-05. Prebuilt zips removed (563 MB), 0 downloads.*

**A 6 MB update download.** Releases now carry two archives instead of one.

### Which one do I want?

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.204.zip` | **585 MB** | **First install** — everything, engines included |
| `mephisto-3.1.204-update.zip` | **5.9 MB** | **You already have Mephisto** — extract *over* your existing folder |

About 99% of the full archive never changes between releases: 874 MB of neural nets and WASM under `lib/engine`, plus 13 MB of onnxruntime under `lib/ort`. The extension's own code is roughly 1 MB. The update archive drops those two directories and nothing else — a hundredth of the download.

> ⚠️ **Extract the update over your existing install, never into an empty folder.** Without the engines it cannot run.

**Extract in place.** Chrome derives an unpacked extension's id from its folder path, so replacing files in the folder you already loaded keeps the same id — and native engines, registered against that id, keep working. Unpacking into a *new* folder changes the id and means re-running the native-host installer.

### If you get it wrong, it says so
Extracting the small archive into a folder that never held a full install leaves an extension with no engines, and every symptom after that points somewhere else — an engine that never loads, a panel that analyses nothing. The worker now probes for a file inside each omitted directory at startup, and the panel tells you to fetch the full archive. That warning takes priority over the update notice, because the fix is the full download rather than whatever is newest.

### Building them
`release-zips.sh` builds both and verifies the split before either ships. `lib/` is **not** excluded wholesale — it also holds `chess.js`, `lru.min.js`, jquery, materialize and chessboard, and the extension does not boot without them. Only `lib/engine` and `lib/ort` are dropped, and the builder refuses to produce an update archive missing `chess.js`.

### Coming: Chess.com puzzles
Once [the upstream pull request](https://github.com/AlexPetrusca/Mephisto/pull/37) is merged, a database of **620,000+ Chess.com puzzles with their solutions** will be published for import the same way as the Lichess one — same settings page, same import button, same behaviour: on a hit the panel plays the known line with **no search at all**. It covers rated tactics and the daily archive, and carries each puzzle's rating, pass rate and average solve time alongside the solution.

Everything else is unchanged from 3.1.203.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.203...v3.1.204

---

## Mephisto 3.1.242 — unpacked extension (load in Chrome)

*Tagged v3.1.242 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**The Maia rating band swaps live.** Changing the band mid-game no longer blanks the panel.

### Which download?

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.242.zip` | **585 MB** | **First install** — everything, engines included |
| `mephisto-3.1.242-update.zip` | **6 MB** | **You already have Mephisto** — extract *over* your existing folder |

> ⚠️ Both archives unpack into a `Mephisto-3.1.242/` folder, so "over your install" means copying that folder's **contents** into the folder Chrome already has loaded. Automatic updates avoid this entirely.

### What changed

The Maia Level dropdown sat in the engine-reload group, whose answer to everything is a full panel reload — so nudging the band mid-game tore down the panel and looked like a page refresh.

But a band change is an **engine** re-init, not a panel concern: the engine loader already treats the band as part of the net's identity. The dropdown now swaps the net in place — the old band's search is abandoned, the new `.onnx` loads, and the current position is re-analysed on the new band — while the panel, the position and the game state stay exactly where they were. The dropdown is disabled during the load so one swap runs at a time, and the old full-reload behaviour survives only as the failure path.

Engine and Variant switches still reload the panel; those genuinely rebuild everything.

### Known limits

Verified by the test ladder against the shipped source, not yet by a mid-game band flick on a live board — that is a ten-second check: change the band during a game, the panel should stay put and the readout should re-fill on the new net.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.241...v3.1.242

---

## Mephisto 3.1.243 — unpacked extension (load in Chrome)

*Tagged v3.1.243 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**A one-line correction to a comment that promised something the code forbids.** No behaviour change.

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.243.zip` | **585 MB** | **First install** — everything, engines included |
| `mephisto-3.1.243-update.zip` | **6 MB** | **You already have Mephisto** — extract *over* your existing folder |

### What this is

3.1.239's rules-certification comment claimed it "lets a single-move engine premove at all". That was wrong when written: certification answers whether the *prediction* is trustworthy, but a one-node Maia line contains no reply of ours to play — and 3.1.241 added the gate that rejects such lines two lines above the comment, leaving the code promising the exact thing it forbids. A user caught the contradiction between the release messages; this was its source.

The comment now states what the bypass does **not** do, why, and where the real Maia-premove mechanism (one extra inference on the rules-certified future position) will plug in when built.

To be plain about the current state: **premoves work for every searching engine; neither Maia premoves today**, and with a Maia selected the toggle is safely inert.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.242...v3.1.243

---

## v3.1.245 — the second inference survives its own net load

*Tagged v3.1.245 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**The second inference survives its own net load.** A same-day review fix to 3.1.244 — nothing new to configure.

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.245.zip` | **585 MB** | **First install** — everything, engines included |
| `mephisto-3.1.245-update.zip` | **6 MB** | **You already have Mephisto** — extract *over* your existing folder |

### What this fixes

- The Maia second inference's pending window was 5 seconds — but the first ask of a game also pays the isolated client's **own net load**, which takes seconds on the Maia-3 transformer. The first premove opportunity of the game was silently dropped on exactly the engine the feature is for. The window is now 12s; it only *frees the slot* — whether an answer is stale is decided by the position check when it arrives, so the longer window can never play a stale move.
- `bestmove (none)` (the prediction delivers mate or stalemate, so there is no reply) now frees the slot immediately instead of wedging it until the timer.

Ladder: 1,334 checks, the `(none)` path executed.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.244...v3.1.245

---

## v3.1.246 — PV Arrows: the whole line on the board

*Tagged v3.1.246 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**The whole line, on the board — and forced lines stop dressing like engine lines.** Plus an autonomous test sweep of the premove stack.

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.246.zip` | **585 MB** | **First install** — everything, engines included |
| `mephisto-3.1.246-update.zip` | **6 MB** | **You already have Mephisto** — extract *over* your existing folder |

### PV Arrows (new, opt-in)

Turn on **PV Arrows** and every ply of the engine's best line is drawn ahead on the board as a thin **grey numbered arrow** — you see where the line is going, not just its first move. **PV Arrows Length** picks how many plies, 1–50 (default 5). Grey is deliberate: the line is the engine's current suggestion, revisable at the next depth, so it must not wear the certainty colours. Every ply is validated against the rules before drawing, so a truncated or garbled line never draws a wrong arrow. Single-move engines (the Maias) have no line to draw — the setting is safely inert there.

### Forced lines recoloured

The forced-continuation ramps were blue (yours) and violet (theirs) — sitting right next to engine line #1's blue and line #5's purple. Certainty read as suggestion. Now **magenta for your moves, teal for their forced replies**: hues no engine line uses. Layering is strict: grey speculation at the bottom, forced certainty above it, live engine arrows on top.

### Verified live, autonomously

The whole release ran a scripted sweep in a real browser (fresh profile, this exact build) before shipping:
- **maia3 premoves**: 5 queued site premoves + 5 certified instant replies in a live game — the second inference works on both Maias now, not just Maia-1
- **PV Arrows at depth 26**: grey plies drawn alongside 3 multipv arrows on an analysis board, no clashes, no errors
- **Settings survive a full browser restart** (fresh-profile regression for the class of bug fixed in 3.1.227)
- **Options page**: all premove + PV Arrows rows render and register with zero console errors on a fresh install
- **SF-18 regression game**: searched to depth, won by checkmate, no page errors
- chess.com could not be tested logged-out (login wall on /play/computer) — its premove click path remains user-verified only

### Also

- The panel's Premove tooltip now states what actually ships: the confidence dial and the Maia second inference (it still described the fixed 13/14 window from two releases ago).
- Ladder grows to 1,345 checks: the PV walker is executed against real chess.js (clean line, illegal ply stops the walk, garbled token, promotion, junk fen), and a colour pin fails the build if the forced ramps or the walk grey ever collide with an engine-line hex again.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.245...v3.1.246

---

## v3.1.247 - Bug fixes, Arrow Colours + custom positions vs the computer

*Tagged v3.1.247 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**Your arrows, your colours — and custom positions vs the computer work on both sites.** Driven by another autonomous live-test session that found and fixed two detection bugs on the way.

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.247.zip` | **585 MB** | **First install** — everything, engines included |
| `mephisto-3.1.247-update.zip` | **6 MB** | **You already have Mephisto** — extract *over* your existing folder |

### Arrow Colours (new, Appearance)

Every arrow family the panel draws is now re-colourable: **engine lines 1–5, forced continuations (yours / theirs), PV Arrows, the threat arrow, and book arrows**. Each row pairs a native colour picker with a hex field, synced both ways. An empty field means the shipped default — and validation lives at the drawing site, so a junk value falls back instead of vanishing an arrow. Forced ramps derive their depth shades from your base colour. Changes repaint live, no reload.

### Custom positions vs the computer (fixed / new)

- **lichess "From Position" with Black to move first never worked**: the start was captured by scraping pieces, which cannot carry the *turn*, and the off-by-a-tempo reconstruction failed the king-en-prise validator on every scrape — the panel just said "not detected". The page's own FEN now wins at move 0 (round JSON, or the variant-link editor href on vs-AI pages, which carries the turn).
- **chess.com `/practice/custom` is now a first-class board.** Its FEN travels in the URL — which the page strips right after load, so it is recovered from the navigation timing entry.

Both found by engineering forced-mate test positions for the premove stack, and both verified live: a black-to-move From-Position game reconstructs exactly (en-passant target included), and the practice board queued a **2-deep premove chain ending in a promotion** (`Rxg8` then `e8=Q` — the deep-chain and promotion-premove cases in one line).

### Also verified live this session

- En-passant premove geometry executed in the ladder (the "only legal after exactly that move" case)
- Panel UI reviewed with everything on and everything off; Appearance and General pages clean on a fresh profile
- 4-player chess could not be reached autonomously (app routing + human matchmaking) — that lane stays manual

Ladder: 1,355 checks. The colour logic is executed (override applies, junk falls back, ramps derive shades), and a changed forced-ramp contract was re-pinned in the same commit.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.246...v3.1.247

---

## v3.1.248 — legal castling, and a test rail that gates releases

*Tagged v3.1.248 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**Castling can no longer pass through a check, and the test rail gates every release from here on.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.248.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.248-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### The castling bug (fixed)

The bundled chess.js validated only the castling **destination** square, so castling **out of** or **through** a check was offered as a legal move - and Maia, which plays the library's move list verbatim, would sometimes click an illegal O-O on a live board. The move generator now applies the full rule: every square on the king's path, start to destination, must be unattacked (with the correct exceptions: atomic's connected kings, antichess's absent check concept - and an attacked b1 still does not block O-O-O, since it is not on the king's path). Everything downstream inherits the fix: both Maias, forced lines, premove safety, PV validation. Seven ladder pins now run the real library on exactly these cases.

### The test rail is finished

The second half of v3.1.238:
- **chess.com fixture** - a real bot game captured mid-play (board, move list, player boxes)
- **lichess live-game fixture** - carries the player boxes, so **Hide Opponent Name is finally testable**: the harness counts matches of the real selector constant, exactly as the extension does
- **headless runner** - `node test/run-harness.js` serves the repo, runs the whole suite in headless Chromium, and its exit code is the verdict. `release-zips.sh` now refuses to cut archives while the harness is red (and warns loudly when puppeteer is not resolvable rather than skipping silently).

19 checks across three captured pages; this release is the first one built through the gate.

### Also

- README: the shipped list said "18 items" and held 36 - counts are honest now, all em dashes are gone, a stray roadmap item left the shipped dropdown, and the settings reference plus the 4PC section collapse like the other big sections. Overall it reads shorter.
- Ladder grows to 1,362 checks (castling legality pins included).

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.247...v3.1.248

---

## v3.1.249 — a description on every setting

*Tagged v3.1.249 on 2026-08-14. Prebuilt zips removed (564 MB), 0 downloads.*

**Every setting now says what it does, and the Game Review nav stops overlapping itself.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.249.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.249-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### Hover descriptions on everything

Thirty-six controls across the two settings pages had no tooltip at all. Every one now carries a single plain sentence saying what it does - what the setting changes, not what a chess engine is. That is all 59 controls covered, including the ten arrow-colour rows from v3.1.247.

The ladder gates this from here on, and it proves its own check first: the predicate must pass a tipped row, **fail** a muted one, and read both markup shapes before the scan runs. A scan that can only ever say "all good" is worth nothing, so it is not trusted until it has failed something.

### The nav that drew on top of itself

Materialize hard-codes `height: 1.5rem` on table-of-contents links, so any Game Review nav entry that wrapped to a second line rendered over the next one ("Across games" through "Fair-play indicators"). Height comes from the content now. Measured in the browser: zero overlapping pairs, wrapped entries get their full two lines.

### Verified

In the rig on this exact build: 59 tooltipped controls, none with empty text, a real hover renders the real sentence, and the nav measures clean. Ladder 1,364 checks; the fixture harness gate ran before these archives were cut.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.248...v3.1.249

---

## v3.1.250 — the panel stops waiting for the engine

*Tagged v3.1.250 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**The panel answers while the engine is still loading - and one popular fix idea was measured, rejected, and thrown away instead of shipped.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.250.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.250-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### The pause after a browser restart

Opening the panel used to `await` the engine **before** registering its message handler. For the whole cold-start window - service worker waking, offscreen document created, a 100MB+ net read from disk - the panel was open but deaf: no scrape, no board, no evaluation. That is where "nothing happens for ten seconds after a restart" comes from. Engine init now runs alongside the rest of the boot; the engine host already queues anything sent while it loads, and the first search is fired by the first scraped position anyway.

**Honest limit:** on a clean rig profile the extension boots in well under a second (engine ready ~70ms, first info ~700ms), so the long stall does not reproduce there. The ordering bug is real and fixed; the size of the win on a big, loaded profile is unmeasured.

### Playing while the machine is busy: measured, not fixed

Reproduced first: with all ten cores saturated by other work, the panel's response to a position change went from a **323ms median to 1239ms**, one sample never arriving inside 12 seconds.

Then the obvious fix - hand the engine fewer threads while the machine is starved - was built, and its own measurement killed it. Interleaved A/B under sustained saturation, 14 samples per arm: **999ms median on the full thread budget vs 1712ms on one thread.** Fewer threads made it *worse*. The code was reverted rather than shipped, and the roadmap item now carries the numbers so the next attempt starts from data. The remaining suspect is the page thread itself (scrape, parse, draw), which is where the next measurement goes.

### Also fixed

- The descriptions added in v3.1.249 were **invisible in practice**: no marker to hover, the Appearance page never initialised tooltips at all, and Materialize waited a full second. Every tooltipped label now carries the info icon, both settings pages initialise centrally, and the delay is 250ms.
- The ten arrow-colour rows had landed **inside** the Board and Pieces group, splitting Pieces from Board. They are their own **Arrow colours** section now, with its own nav entry.

Ladder 1,366 checks; the fixture harness gate ran before these archives were cut.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.249...v3.1.250

---

## v3.1.251 — Brilliant, Great, Miss: every move gets a name

*Tagged v3.1.251 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**Every move gets a name.** Game Review now classifies with the full published scheme, and the three special verdicts are earned rather than guessed.

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.251.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.251-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### The classes

**Brilliant · Great · Best · Excellent · Good · Book · Forced · Inaccuracy · Mistake · Miss · Blunder**

The ordinary ones are bands of **win probability lost**, not centipawns:

| Class | Win% lost |
|---|---|
| Best | the engine's own move |
| Excellent | under 2 |
| Good | 2 to 5 |
| Inaccuracy | 5 to 10 |
| Mistake | 10 to 20 |
| Blunder | 20 or more |

These are tighter than the 30/20/10 bands they replace, and **the panel's live stats moved with them** - one move must not get two different verdicts depending on which screen you read it on.

### The three that are earned

- **Brilliant** - material has to be genuinely offered. The exchange on the destination square is *replayed on the board*, cheapest attacker first, and the move only qualifies if the mover comes out behind. On top of that it must be near-best, the position must not already be winning (a sacrifice you can afford is just a good move), and it must not throw the game away.
- **Great** - the only move that holds, measured against the engine's **second choice**: if everything else drops a chunk of the game and this one does not, finding it was the move.
- **Miss** - a winning position let go. That reads nothing like a slip in a level game, so it gets its own name instead of being filed as a Mistake.

### Verified

Run end to end on **Morphy's Opera Game**: 1 Brilliant, 6 Great for White, and the full band spread for the defence, rendering in their own colours in both themes. The classifier is also executed in the ladder across every class, including the sacrifice detector on real positions (a queen taken for a pawn is a sacrifice; an even trade is not) - 1,388 checks, and the tests that pinned the old bands were rewritten in the same commit rather than left asserting the past.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.250...v3.1.251

---

## v3.1.252 — the Analysis page, and verdicts on the board

*Tagged v3.1.252 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**A dedicated Analysis page, and every verdict now shows on the board.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.252.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.252-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### Analysis (new page)

The floating panel is built for a live game: small, out of the way, one engine at a time. Studying wants the opposite, so it gets its own page.

- **A large board with the move list beside it.** Step with the arrow keys or click any move.
- **Both engines at once.** The human model's most likely moves *with their probabilities*, next to the engine's lines *with their evaluations* - and both drawn on the board, the engine's numbered 1, 2, 3 in its own colours and the human model's in magenta. Agreement and disagreement are visible at a glance, which is the whole point of the page.
- **Win% and evaluation bars** flanking the board: the human number on one side, the engine's own on the other.
- **Moves by rating** - the same position asked of six Maia bands, so you can see the choice change as strength does.
- **Best / mistake / blunder tallies** above the move list, filled in as you step.
- **Depth 12 by default**, quick enough to walk a whole game; PGN or FEN in, sample game included.

Leaving the page disposes its engines, and the drivers are now **shared with Game Review** rather than duplicated.

### Verdict badges on the board

Every classification draws its own badge on the move's destination square, the way a review is read everywhere: **!!** Brilliant, **!** Great, a star for Best, a check for Excellent, a thumb for Good, a book for theory, **?!** **?** **??** down the other side, and a cross for a Miss. The engine's candidate arrows now carry their **rank number**, so the line it actually likes is the one marked **1**. The Game Review board is larger, with the move list narrowed down its side.

The badges are our own artwork in the familiar visual language: the well-known icon set belongs to chess.com, so it is not redistributed here.

### Two bugs the new page found

- **Maia was never told how many lines to answer with**, so the human model produced a single move at 100% - in Game Review as well, not just the new page.
- The PGN loader was handed the parser's move *records* where it expected strings, so a pasted game refused to load while a bare position analysed fine.

Ladder 1,402 checks, including the badge geometry, the class-to-badge coverage, and the new page's wiring; the fixture harness gate ran before these archives were cut.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.251...v3.1.252

---

## v3.1.253 — a flat menu, and Analysis leads with the board

*Tagged v3.1.253 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**A flat menu, and the Analysis page opens on the board instead of a form.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.253.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.253-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### The menu is a plain list

Settings and Appearance were behind an accordion. They are ordinary entries now:

**Getting Started · Settings · Appearance · Analysis · Game Review · About · Disclaimers**

Every page is one click, and the dropdown machinery went with it.

### Analysis leads with the board

The page opened on a form, which is the Game Review shape and the wrong one for a page you open to *look at a position*. Now:

- **The board is the first thing on the page**, with the move list, tallies, both engine columns and the rating bands around it.
- **A compact strip above the board** carries what you change while studying: depth, lines, the human rating band, and a **Paste PGN/FEN** button that takes either straight from the clipboard.
- Loading and engine settings moved below the board, and the strip writes the same settings as those rows, either way round.

### Fixed while verifying

Returning to the page rebuilt the board while its stylesheet was still disabled, so the renderer measured a full-width host and kept that size, pushing the move list underneath. A resize observer rebuilds on a real width change, which covers both the re-entry race and window resizing.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.252...v3.1.253

---

## v3.1.254 — infinite analysis, one control look, and a full regression sweep

*Tagged v3.1.254 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**Analysis thinks until you move on, every control matches everywhere, and the last five releases were re-tested end to end.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.254.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.254-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### The search has no budget

There is no depth to choose on the Analysis page any more. The engine keeps working on the position in front of you and the lines deepen while you look at them; stepping to the next move stops that search and starts the next one. The running depth sits **beside the engine's lines** rather than in the page's notice line, where it used to erase whatever the page had just told you about a second after it appeared.

### Moves by rating, every band

The chart sweeps in **100-Elo steps**: Maia 1 across its twelve nets, Maia 3 across its whole **600 to 2600** dial - and because Maia 3 is one net with a rating input, that whole sweep costs a single load.

### One control look

Inputs, selects and text boxes are declared **once**, in the shared stylesheet. A field on Game Review or Analysis is now the same height, frame and focus ring as the same field in Settings. They had drifted page by page - the Analysis toolbar was rendering 45px tall against 30px everywhere else, because Materialize's own input rule loads later and was winning.

### The regression sweep of v3.1.249-.254

Everything from the last five releases was re-driven on this build, with edge cases. What passed: the flat menu and every page reachable; all 59 settings tooltips present, non-empty and actually rendering on hover; the Game Review nav no longer overlapping; the full classification scheme with **Brilliant/Great** earned on a sacrificial game; badges drawn through a whole game and engine arrows numbered; the board leading the page with the move list beside it; the infinite search deepening while a position sits and restarting when it does not; both engines answering and drawing; and a live premove test on the practice board still queueing a **2-deep chain ending in a promotion**.

Three real bugs the sweep found, all fixed here:

- **chess.js does not throw on junk FENs** - `not a fen at all` was quietly accepted and the start position analysed instead. The shape is validated before chess.js sees it.
- **A half-copied PGN loaded silently as a shorter game.** The loader now reports how many moves it understood, and names the token it could not read.
- **The Analysis toolbar did not match the other pages** (the control-look drift above).

Ladder 1,414 checks; the fixture harness gate ran before these archives were cut.

### Known limit

The lichess "play the computer" dialog resisted automation in this session (its colour buttons are the submit, and it remembers the last setup per profile), so the panel-side premove re-check ran on the chess.com practice board instead of a lichess game. Same code path, different site.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.253...v3.1.254

---

## v3.1.255 — the Analysis page, and a screen reader that stops asking twice

*Tagged v3.1.255 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**The Analysis page as asked for, and the screen reader stops asking the model twice.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.255.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.255-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### Analysis

- **The board is bigger, and you can play on it.** Click or drag; a move continues from wherever you are in the line.
- **Clicking any line plays it** - engine, human model or book.
- **One eval bar, wider, with the number inside it**, and **win / draw / loss** beside the board.
- **Everything above the board**: engine, human model, rating band, lines, threads, **hash**, WDL toggle, book toggle, and load/paste/start buttons.
- **Every engine is selectable**, the way Game Review does it.
- **Switching the human model no longer resets the analysis** - the two engines are started and stopped independently now.
- **Moves by rating** draws a line per move across the bands (with the band each peaks in) instead of a wall of blocks.
- The **tallies counter is gone**, and **arrow rank numbers sit at the head of the arrow**, not under the piece that is about to move.
- **Opening books** load from PGN or JSON. A Polyglot `.bin` is recognised and refused *with the reason*: decoding one needs its Zobrist key table, which comes from GPL sources and is not vendored here. Say the word if you want it vendored anyway.

Fixed while testing: a search that has been told to stop keeps emitting until its `bestmove` arrives, so on a long search those lines were collected as the **next** position's - visible as an engine line that is illegal on the board (`d2d4` after 1.d4). Stopping now waits for the engine to really stop, and the renderer drops any line whose first move is not legal in the position on screen.

### The screen reader

Measured per read on one machine: **decode 25ms + board detection 84ms + position model 645ms**. The shipped position model turned out to be **already int8-quantised** (MatMulInteger / ConvInteger), so the "quantise it" lever was spent before it was pulled.

What was left was not asking:

- the **board box is cached** while the image geometry holds, and re-detected when a read comes back unsure;
- the 256×256 crop is **hashed**, so a board that has not changed a pixel skips the model completely.

**Repeat reads went from ~670ms to ~26ms**, and a real board change was verified to invalidate both caches and produce the new position. Every stage is timed in Copy Diagnostics now (`stages=decode…/detect…/read…`).

**What is left**, honestly: a board that genuinely changed still pays ~700ms. That needs a smaller model or a GPU execution provider - the bundled onnxruntime here is the WASM build, so WebGPU means vendoring another runtime, and a smaller model means retraining rather than converting.

### ChessBase tactics

Investigated with a live probe rather than guessed at. Their page renders **the whole app into one canvas** (777×740 here, not square), which is exactly why finding the board by shape was unreliable - there is no board element to find. The model itself is reachable and already gives us the FEN. The workable route, now that it is written down: locate the board **inside** that canvas with the board-detector model this extension already ships (84ms, and now cached), then settle orientation by comparing what the detector reads against the FEN the model reports. Not built yet.

Ladder 1,421 checks; the fixture harness gate ran before these archives were cut.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.254...v3.1.255

---

## v3.1.256 — Polyglot books, and a WebGPU experiment that failed honestly

*Tagged v3.1.256 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**Polyglot `.bin` opening books, and a WebGPU experiment that was measured and turned down.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.256.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.256-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### Polyglot books

Analysis reads real `.bin` books now, alongside the PGN and JSON ones. Load one, and the book column lists its moves with their weights; click a move to play it, and the book follows the position.

The format keys positions by its own Zobrist hash, so its **781-constant table is vendored as data** - a book cannot be read without exactly those values. It is the format's published table (Polyglot, transcribed from python-chess; both GPL, credited in the file, 20KB).

The part that matters: the implementation is verified against **the format's own published test keys**, not against itself. All nine specification positions match, including the en-passant cases - the file only counts when a pawn can actually take there, and getting that wrong produces a book that silently never matches, which looks exactly like an empty book. Move decoding covers the castling encoding (the king "takes" its own rook) and promotions.

Measured: a real 1.5MB book, 77,872 positions, parses in **44ms**.

### WebGPU: tried, measured, turned down

Same machine, same model, cross-origin isolation on so WASM threads were live:

| Runtime | Median inference |
|---|---|
| WASM (what ships) | **631ms** |
| WebGPU | **774ms** |

**23% slower.** The position model is int8 (MatMulInteger / ConvInteger); the WebGPU execution provider has no implementation for those operators, so they fall back to the CPU and pay the transfer cost on top. Vendoring 27MB of extra runtime to lose 23% is not a trade worth making, so it was not vendored - and the numbers are written into the roadmap so nobody repeats the experiment.

What would actually help remains a genuinely smaller model, which means retraining rather than converting.

### Also verified in this release

Game Review re-run end to end on this build (the shared engine driver changed in v3.1.255): classification, badges, numbered arrows and the board-first layout all still pass. Ladder 1,437 checks including the sixteen new Polyglot ones; the fixture harness gate ran before these archives were cut.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.255...v3.1.256

---

## v3.1.257 — licensing recorded, and screen reads down to 2-3ms

*Tagged v3.1.257 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**The Polyglot key table is recorded in the licensing, and a screen that has not changed is no longer decoded.**

| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.257.zip` | **585 MB** | **First install** - everything, engines included |
| `mephisto-3.1.257-update.zip` | **6 MB** | **You already have Mephisto** - extract *over* your existing folder |

### Licensing

`lib/polyglot-random.js` is **GPL-3.0 data** - the book format's own 781-constant key table, from Polyglot via python-chess. It is now named in all three places that matter:

- **THIRD-PARTY-NOTICES.md** with its provenance, and why it is vendored as data rather than reimplemented (a book cannot be read without exactly those values);
- **LICENSING.md**, in the list of copyleft components the combined distribution inherits from;
- the **README** credits.

The conclusion is unchanged - this distribution was already governed by AGPL-3.0 - but a GPL component that is not written down is the problem, not the licence.

### Screen reading: 670ms → 2-3ms on a repeat

The remaining cost was hiding in plain sight. With the model and the board detector already cached, a repeat read still took ~26ms, and **~23ms of that was decoding an image whose pixels had not changed**.

The captured frame is now hashed **before** it is decoded (sampled rather than byte-for-byte, since a 300KB base64 string is not free to hash whole), so an unchanged screen answers straight from the previous result - no decode, no detection, no model.

| Stage of the work | Repeat read |
|---|---|
| Originally | ~670ms |
| After the board-box and crop caches (v3.1.255) | ~26ms |
| Now | **2-3ms** |

A board that genuinely changed still pays the full ~700ms, and the invalidation was verified end to end: read a position, change it, and the new placement comes back with every cache flag cleared. Three layers, each one checked - a stale position would be far worse than a slow one.

Ladder 1,440 checks; the fixture harness gate ran before these archives were cut.

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.256...v3.1.257

---

## v3.1.259 - the shipped-build sweep

*Tagged v3.1.259 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.259 - a sweep of the shipped build, and the five faults it found.** Everything here came out of driving the published v3.1.258 rather than reading it: every settings control set and read back after a reload, every site route executed, and the edge cases pushed on purpose.

| What | Detail |
|---|---|
| Controls driven | 94 (69 General, 25 Appearance), each set and re-read after a reload |
| Site routes executed | 29 across lichess, chess.com, Blitz Tactics, taketaketake, ChessBase |
| Faults found and fixed | 5 |
| Tests | 1,512 ladder checks (was 1,455), 19 fixture checks |
| Measured, not guessed | scrape 17-38µs, options boot 78-201ms, engine start 60-531ms |

### Fixed
- **The settings export could not be re-imported.** The service worker keeps bookkeeping in the same store that is not a setting (startup timings as an array), export dumped it, and import refuses any file holding a non-string value so that a wrong file cannot half-apply. Export now emits only settings. Before: "that does not look like a Mephisto settings file" and nothing restored. After: a 3-key export re-imports and both settings come back.
- **Infinite now means infinite.** The slider's last notch was implemented as `go infinite` stopped by a settle rule with a two-minute ceiling, which is a time limit under another name. Both are gone, and so is the backstop timeout. Stop interrupts the search instead of waiting for a position that would never end. Measured: depth 24 at 5s, 33 at 15s, 34 at 30s, 34.2M nodes, never resolving on its own.
- **An options link with no page behind it left a blank screen.** A hash with no nav entry threw before anything rendered, with no way back but editing the URL. It falls back to General now.
- **The board hunt gave up for good after ten seconds.** These sites are single-page apps, so a board can appear long after the document loaded, and the only path that captures a custom start position could then never run. It drops to one check a second and keeps looking; measured cost of that watch is about a microsecond a second.
- **The budget tooltip promised reproducibility it cannot keep.** Depth is only reproducible on one thread: three depth-14 searches of one position agreed exactly on one thread and read 27/25/24cp on four. The tooltip names the condition now.

### Also
- The engine pass and the human pass in Game Review run at the same time instead of queueing. Worth about a second on a long game with Maia 3, and the report is byte-identical.
- The progress line names the position before searching it, so an unbounded review no longer looks dead.

### Checked and found working
Every control persisted across a reload; Restore Defaults on both pages; all 14 languages with no raw key on screen; the colour picker and hex field in both directions, with junk and empty falling back to the shipped default; out-of-range, negative and empty numbers never reaching storage as NaN; the humanize mix normalising when the shares do not sum to 100 and thresholds forced ascending when hand-edited out of order; a junk import refused with the store untouched.

### Known limits
- Auto-update could not be exercised end to end: turning it on requires a Chrome permission prompt that an automated browser cannot grant.
- The chess.com routes were executed as URL matrices and fixtures, not in a live logged-in game.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.259.zip` | 558 MB | first install, or any time you want the full build with every bundled net |
| `mephisto-3.1.259-update.zip` | 6.0 MB | you already have a build installed and only want the code |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.258...v3.1.259

---

## v3.1.261 - the cloud engines use the budget you set

*Tagged v3.1.261 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.261 - the cloud engines use the budget you actually set.** v3.1.260 sent them a depth and nothing else, so the panel's Search Time did nothing on a cloud engine. Now each provider gets the control it understands, and the budget follows the engine.

| What | Detail |
|---|---|
| chess-api.com | takes your **Search Time** (`maxThinkingTime`), with Search Depth as the ceiling |
| stockfish.online | takes a **depth** and nothing else, so choosing it switches the budget to Depth |
| Switching away | puts back whatever budget you had |
| Measured | 50ms reaches depth 14, 2s reaches depth 16, on the same position |
| Tests | 1,570 ladder checks (was 1,551), 19 fixture checks |

### What changed
- **chess-api.com now gets your Search Time.** `maxThinkingTime` is the knob it respects, measured against the live API: 50ms reaches depth 12, 500ms depth 14, 1000ms depth 17, and it plateaus there. The depth setting stays as the ceiling, and the time is capped at 10s so a request cannot outlive its own timeout.
- **stockfish.online switches the budget to Depth.** Its whole API is a fen and a depth, so a panel set to milliseconds was setting nothing. Choosing it moves the Budget control to Depth and remembers what was there; choosing any other engine puts that back. The control itself moves - this is visible state, not a hidden special case.
- The rule lives in the config layer, so the panel's quick-settings dropdown and the settings page cannot disagree about it. The remembered value is written only on the first switch, so hopping between engines cannot overwrite it; someone already searching by depth has nothing remembered and nothing restored.

### Verified
In the real settings page: Time → stockfish.online gives Depth (with the Depth row replacing the Time row, surviving a reload) → another engine gives Time back, and chess-api.com leaves it alone. Against the live API: depth 14 at 50ms versus depth 16 at 2s.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.261.zip` | 558 MB | first install, or any time you want the full build with every bundled net |
| `mephisto-3.1.261-update.zip` | 6.0 MB | you already have a build installed and only want the code |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.259...v3.1.261

---

## v3.1.262 - cloud engines answer the board in front of you

*Tagged v3.1.262 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.262 - the cloud engines answer the position in front of you.** A bug fix for v3.1.260, reported with two screenshots: a game several moves in, the panel saying "best move is d2d4" with its own board showing the starting position.

| What | Detail |
|---|---|
| What was wrong | Every cloud answer after the first move was an answer to the **starting position** |
| Why | On a live game the panel asks with the game's start position **plus the moves since**; a cloud provider has nowhere to put a move list, and the moves were dropped |
| The fix | The moves are replayed onto the position before it is sent |
| Measured | Released 3.1.261: start position asked 5 times out of 5 while the board had moved on. This build: every question matches the board |
| Affects | Both `Cloud: chess-api.com` and `Cloud: stockfish.online`. No other engine - the native hosts and remote-engine.py take the move list directly |
| Tests | 1,580 ladder checks (was 1,570), 19 fixture checks |

### What changed
- The cloud branch replays the UCI move list onto the start position and sends the result. If any move does not fit, **nothing is sent at all** - an answer to the wrong position is worse than no answer.
- Promotions and castling survive the replay; both are pinned by tests.

### On the verification that missed it
v3.1.260's live check confirmed that *a* move came back from the API, not that the move belonged to the position on the board. It also "played" its moves with dispatched MouseEvents, which chessground ignores entirely - so it was really testing the starting position twice over. The live test now plays with real pointer events and fails if the board does not change, and the ladder pins the replay itself.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.262.zip` | 558 MB | first install, or any time you want the full build with every bundled net |
| `mephisto-3.1.262-update.zip` | 6.0 MB | you already have a build installed and only want the code |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.261...v3.1.262

---

## v3.1.263 - online engines named by version, and retried when a provider stalls

*Tagged v3.1.263 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.263 - the online engines are named for the engine they reach, and a stall no longer costs you the move.**

| What | Detail |
|---|---|
| Renamed | `Cloud: chess-api.com` → **Stockfish 18 (online)**, `Cloud: stockfish.online` → **Stockfish 17.1 (online)** |
| Where those numbers come from | each provider's own front page: "Stockfish 18 NNUE" and "Stockfish 17.1 REST API" |
| Settings still names the provider | and still says the position leaves your machine |
| New | a stalled or rate-limited request is retried once |
| Stored settings | the engine ids did not change, so an existing choice keeps working |
| Tests | 1,587 ladder checks (was 1,580), 19 fixture checks |

### Why the rename
"Cloud: chess-api.com" said who answers, not what answers - and what answers is what tells you how strong the reply is. The provider is still named in Settings, next to the cost.

### The retry
Seen live during testing: one request hung past its 20 second timeout while a curl to the same endpoint answered in 130ms, and the game simply stopped with "did not answer within 20s". A stall like that is now retried once, after a short pause.

Retried only for what a retry can fix - a timeout, HTTP 429, or a gateway error. A refused position is **not** retried, because asking again would just be rude, and a rate limit now says so in words instead of showing a bare status number. If the retry also fails, the message says it was retried once.

### Also checked this release
- Every position the online engines are asked about matches the board, move for move, in a real game with autoplay on (both providers).
- Analysing the opponent's turn is normal and is how the eval bar and threat readout work on every engine; what matters is that only our own moves are played, and the game record confirms that.
- The other engines are untouched: a full 10-ply game with the WASM Stockfish made **zero** cloud requests, and the online code path is unreachable unless one of the two online engines is selected.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.263.zip` | 558 MB | first install, or any time you want the full build with every bundled net |
| `mephisto-3.1.263-update.zip` | 6.0 MB | you already have a build installed and only want the code |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.262...v3.1.263

---

## v3.1.264 - en passant accepted, and the rate limit stopped being earned

*Tagged v3.1.264 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.264 - the two things you hit in real games: "wrong FEN" and the rate limit.**

| What | Detail |
|---|---|
| "Cannot evaluate given position - wrong FEN" | chess-api.com refuses any position carrying an **en-passant square** |
| Where that bites | constantly - the ordinary French after 1.e4 e6 2.d4 d5, or right after any pawn's double step |
| Fix | the field is dropped for that provider (measured: it refuses it even when the capture is legal, so there is no rule to satisfy) |
| HTTP 429 from stockfish.online | the same position was being asked about again and again |
| Fix | an answer is remembered for 15 seconds, and two simultaneous asks share one request |
| Measured | nine repeats of one position: **13ms** instead of 684ms (chess-api) and **11.2 seconds** (stockfish.online) of real traffic |
| Tests | 1,596 ladder checks (was 1,587), 19 fixture checks |

### En passant
The refusal was measured against the live API in both cases - with the capture legal and with it not - so it is not a validation rule that can be satisfied, only avoided. The cost is stated rather than hidden: **an en passant capture is invisible to chess-api.com**. stockfish.online takes the field correctly and is the one to use if that matters to you.

### The rate limit
Nothing exotic: the panel re-pushes the same position more often than you would think (the fallback poll, a re-render, a settings touch), and every duplicate was another request against someone's free API. Now a position asked about inside the last 15 seconds is answered from memory, and two asks arriving together become one request. A rate limit also waits longer before its retry than an ordinary blip does.

Worth naming: the cache and the provider table were written *inside* the message listener at first, so they were rebuilt on every message - a cache that could never hit. The live test caught it because it timed the repeats instead of trusting the code.

### Also verified this release
A real game with autoplay on, cloud engine: 8 plies, every question a position the game actually reached, only our own moves played (`d4 c4 e3 Bxc4`).

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.264.zip` | 558 MB | first install, or any time you want the full build with every bundled net |
| `mephisto-3.1.264-update.zip` | 6.0 MB | you already have a build installed and only want the code |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.263...v3.1.264

---

## v3.1.268 - Grind Mode on both sites

*Tagged v3.1.268 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.268 - Grind Mode works on both sites, and the Grind Delay row stops looking wrong.**

| What | Detail |
|---|---|
| Lichess | `button.new-opponent` - verified end to end against a real opponent |
| Chess.com | confirmed working in a real game |
| Chess.com, two button shapes | the labelled one by `new-game-buttons-label`, the bare one by its time control |
| Fixed | the Grind Delay stepper rendered as white browser buttons in a dark page **and did nothing when clicked** |
| Tests | 1,634 ladder checks (was 1,623), 19 fixture checks |

### Chess.com
That site renders the new-game button two ways, and both are handled now:

```html
<button class="cc-button-component cc-button-secondary cc-button-medium cc-bg-secondary" aria-label="New 1 min">
  <span class="cc-icon-glyph">…</span>
  <span class="cc-button-one-line new-game-buttons-label">New 1 min</span>
</button>

<button class="cc-button-component cc-button-secondary cc-button-large cc-bg-secondary" type="button">
  <span class="">New 1 min</span>
</button>
```

The first labels itself, and `new-game-buttons-label` says what the button **is** in any language, so it is matched first. The second says nothing at all, so it falls through to the time control in the label - now read from the `aria-label` as well, so an icon-only button is still found. Game Review, Rematch and New Bot carry no time control and are never taken for it.

### The Grind Delay stepper
It was the one stepper written by hand rather than copied from the row above, so it was missing `set-step-btn` - which is not decoration: the stylesheet styles it and the click handler binds to it. In a dark page it rendered as raw white browser buttons, and its plus and minus did nothing. No theme colours were touched. The test that checks every stepper has both buttons now checks they carry that class too.

### Note on releases
This one is a batch: the chess.com refinement, its confirmation, and the stepper fix, in a single release rather than one release per fix.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.268.zip` | 558 MB | first install |
| `mephisto-3.1.268-update.zip` | 6.0 MB | you already have a build installed |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.264...v3.1.268

---

## v3.1.269 - five roadmap items, one release

*Tagged v3.1.269 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.269 - five roadmap items, one release.** The panel grows to fit what it shows, ChessBase Tactics gets arrows and autoplay off ChessBase's own geometry, pacing reads the situation and not just the clock, the screen reader stops reading itself and says which squares it is unsure about, and a variant the engine cannot play is now said out loud instead of failing quietly.

| What | Detail |
|---|---|
| Items closed | Panel polish, ChessBase Tactics arrows + autoplay, clock rules per situation, better board reading |
| Item narrowed | Duck Chess autoplay - the bundled engine declares 84 variants and duck is not one of them |
| Recogniser | 635ms -> 589ms on a real change (threads 0.6x cores, capped at 6) |
| Tests | 1,701 ladder checks (was 1,634), 19 fixture checks |
| Batch | four commits, one release |

### The panel grows to its content
The panel was a fixed height, so a five-line search, a long PGN or a wide settings row was cut off with no way to reach it. It now measures what it is showing and grows to it, up to the window height minus a margin, and scrolls inside that with a scrollbar in the panel's own colours. Compact mode is unchanged - it stays the size it was. The FEN input on the set-up row was the last control drawing its own white box in a dark panel; it reads the palette now like everything else.

### ChessBase Tactics: arrows and clicking
That site is one canvas with no board element, so there was nothing to hang an arrow on and nothing to click. The probe already read the position out of the page's own model, and now reads the geometry from the same place - `boardWin` gives the board's origin, its square size and which way it is turned, and the canvas scale converts that to page pixels. Arrows draw on the real squares, and autoplay clicks the real square centres. Flipped boards were checked in both orientations.

### Pacing reads the situation
Move Time was one number with variance around it, so a recapture took as long as a quiet middlegame decision. The delay is now scaled by what the move actually is - a recapture on the square just captured, an only-move, a book move and an obvious reply go faster; a real branch point takes longer - and separately by how much time is left on the clock. Both are on top of the existing Move Time, so the setting still means what it meant.

### Reading the board off the screen
Two fixes. The panel was inside the captured region, so the reader could read its own board back and mix the two positions; detection captures now hide the panel for the frame they take. And the recogniser knew its second-choice piece for every square but threw it away - squares it is not confident about are now marked, and one click swaps in the runner-up rather than making you redo the whole read.

Accuracy itself is bounded by the model, which is unchanged here. That needs retraining, not a code change, and it stays on the roadmap.

### Duck Chess
Not shipped. The engine is asked what it can play, and duck chess is not in the 84 variants it answers with, so there is no legal move to place a duck with. What shipped instead: when you pick a variant the engine has not declared, it says so in the readout instead of appearing to think and never answering.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.269.zip` | 558 MB | first install |
| `mephisto-3.1.269-update.zip` | 6.0 MB | you already have a build installed |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.268...v3.1.269

---

## v3.1.270 - the Analysis page, swept

*Tagged v3.1.270 on 2026-08-15. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.270 - the Analysis page, swept.** The page stopped answering after a move sometimes, its Moves-by-rating chart drew the same numbers at every rating, and both of its toggles were wired to nothing. All three are fixed, the chart is rebuilt around the real probabilities, and the search now takes a budget.

| What | Detail |
|---|---|
| The wedge | two analyses could start a search on one engine; the second `position fen` was ignored |
| Maia probabilities | computed by both adapters since the beginning, and thrown away before anything could read them |
| Maia 3 sweep | asked for its rating as `UCI_Elo`, a name that model ignores - so all 21 bands ran at one Elo |
| Toggles | `an_wdl_check` / `an_book_check` were never bound: the framework looks for `_checkbox` |
| Maia bands | 2000 and 2100 have no net on disk; removed from the shared list (see Known limits) |
| New | search budget 1-60s or none, Copy FEN / Copy PGN, a chart with a hover readout |
| Game Review | time per move in tenths, 0.1-15s, kept per mode; smaller badges; an eval bar |
| Tests | 1,738 ladder checks (was 1,634), 19 fixture checks |

### The numbers were not real
Both Maia adapters work out, for every legal move, how likely a human of the chosen rating is to play it - and then emitted the same position eval on every line, so only the move **order** survived. Everything downstream had to invent percentages from that rank. That is why the Human column printed 60.0 / 24.4 / 9.9 for every position at every rating, and why the chart drew flat lines: a decay over the order is identical wherever the order is.

The real number is carried through now (`maiaprob`, read by `parseInfo`, carried by `toResult`), and it is never renormalised over the few lines on screen - it is the chance out of *every* legal move, so four of them summing to 95% is the truth rather than a rounding error.

The second half of the flat chart was separate: **Maia 3 takes `SelfElo` / `OppoElo`**, the sweep sent `UCI_Elo`, and `setoption` ignores a name it does not know. Twenty-one bands, one Elo, twenty-one identical answers. Maia 1 was never affected - it builds a separate net per band. Measured after the fix, on the starting position:

| Move | 600 | 1600 | 2600 |
|---|---|---|---|
| e4 | 62.4% | 63.8% | 45.8% |
| d4 | 21.4% | 25.0% | 35.7% |
| Nf3 | 2.5% | 2.2% | 8.9% |
| c4 | 0.0% | 2.6% | 5.2% |

The test meant to cover this asserted the *wrong* option name as its evidence, so it passed the whole time. It now checks every option the sweep sends against the ones the model actually answers to.

### The search that stopped answering
`analyseCurrent` awaits before it starts anything, so two calls could both get past `await stopSearch()` - the second sees no live search, because the first has not registered its own yet - and both then called `startInfinite` on the same engine. An engine that is already searching **ignores** the next `position fen`, so it kept thinking about the old board and streamed those lines into the new callback, where every one of them is illegal and gets filtered out. It showed as "thinking..." that never ended while the depth counter climbed 24, 27, 29 without ever restarting from 1, which is what gave it away. The analyses are serialised now, and a result is matched to its position rather than its cursor index, because playing a move truncates the line and the same index can be a different board.

### The chart
One plot instead of a row per move: every move a line in the same axes, named at its own end in its own colour, a dot per band, the leader's area shaded, a labelled probability axis, and a readout that follows the pointer giving every move's value at the band under it. It honours the Lines setting, which it never did - three was pinned in three separate places, one of them a hardcoded table of three probabilities that could not describe a fourth move.

### Things that were quietly not working
- **Both toggles on the page were inert.** The settings framework binds a control by `<name>_<type>`, so `an_wdl` as a checkbox looks for `an_wdl_checkbox`; the markup said `an_wdl_check`. Neither toggle ever received its default - Win / draw / loss read Off on a fresh profile while the code behind it behaved as if it were on - and clicking either one saved nothing.
- **Two Maia rating bands that do not exist.** `lib/engine/maia` ships 1100 through 1900 and 2200. 2000 and 2100 were offered wherever a rating is picked, with nothing behind them.
- **The setup strip** wrapped into a ragged second row, and its number fields and selects were plain browser controls beside the extension's own framed toggles: three heights, three label baselines.

### Also
- A **search budget** on the Analysis page: 1 to 60 seconds, or the notch past 60, which is exactly `go infinite`.
- **Copy FEN** and **Copy PGN** under the board. A line that did not start from the initial position carries its FEN tags.
- The **board takes the width** the right column was wasting beside the notation, and the chart moved under it, where its readout does not cover it.
- **Game Review**: time per move runs 0.1s to 15s in tenths (whole seconds were far too coarse at the end where a review lives - 1s to 2s is a doubling), and each mode keeps its own number, so switching no longer reads depth 12 as a 12ms budget. Smaller verdict badges and rank tags, and an eval bar beside the board.

### Known limits
- **Game Review's own rating dropdown still lists 2000 and 2100 in this build.** The shared band list was fixed; that page writes its own copy out by hand in markup and was missed. It is fixed on `master` and will ship with the next release - until then, picking either one there asks for a net that is not on disk. The test now checks every band list in the tree rather than only the constant.
- The Maia 3 sweep loads its own copy of the 92MB net alongside the one the Human column is using, so the **first** sweep after picking Maia 3 is a long wait; the band counter is the only sign of it. After that a full 21-band sweep takes a few seconds.
- Board-reading accuracy is unchanged and still bounded by the model, which needs retraining rather than tuning.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.270.zip` | 558 MB | first install |
| `mephisto-3.1.270-update.zip` | 6.0 MB | you already have a build installed |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.269...v3.1.270

---

## v3.1.272 - all fourteen quick wins

*Tagged v3.1.272 on 2026-08-16. Prebuilt zips removed (564 MB), 0 downloads.*

**v3.1.272 - all fourteen quick wins, in one release.** Everything small on the roadmap, built, and every one verified live in a real browser in dark mode before this was cut.

| What | Detail |
|---|---|
| Panel | the number column says Eval or Probability; a Maia arrow carries the move's % |
| Panic key | X (rebindable): panel, arrows and search gone in one press, no setting changed |
| Analysis | opening named, tablebase asked at ≤7 men, the chart draws everything above 1% |
| Both pages | drop a .pgn anywhere; amber warnings for thread/hash numbers the machine cannot honour |
| Game Review | a time-remaining estimate, the move the game turned on, a think-time card per player |
| Settings | a search box over the rows; a storage readout naming the puzzle database |
| Languages | the 23 keys the 13 non-English locales were missing, translated, tips included |
| Tests | 1,775 ladder checks (was 1,753), 19 fixture checks, two live rigs green on this exact tree |

### The panel says what its numbers are
With an engine the line list shows evaluations; with a human model the same column is a probability, and nothing on screen said which. One small header now does - and a Maia line's arrow carries the move's probability (65% / 23% / 3%) instead of an eval label that is identical on every line, because Maia scores the position once: for a human model the probability IS the ranking. It rides the numbering toggles you already have; both off still means a bare arrow.

### The panic key
One press of X: the panel, the eval bar and every arrow are gone and the search is stopped - in that order, screen first. It lands on the same code the close button always used, so it is a route to an exit that existed rather than a second exit that could drift. No setting changes; reopening from the toolbar brings everything back exactly as configured. Rebindable like every other key.

### The Analysis page knows what it is looking at
The opening is named from the review's bundled table - keyed by position, so transpositions come out right, and stepping back walks back through the names. Once seven or fewer men are left the lichess tablebase is asked through the worker the panel already uses: "Tablebase: win in 43 — Kd2". Both answers are position-guarded - a slow reply for a board no longer on screen is dropped, never drawn. And the rating chart draws every move above 1% (verified: eight where it drew four) because the five-line clamp was ours, not the model's.

### Game Review reads its own data out loud
- The progress line carries a **time-remaining estimate** derived from the bar itself, held back until 3% is done because the first positions are dominated by the engine load.
- **The move the game turned on** is named under the graph - the biggest win-percent swing, preferring one that crossed the 50 line, clickable, in its verdict's colour. Measured honestly: the Blackburne Shilling cliff reads "5. Nxf7 — White 44% → 17%", while the Greco trap line - which slides rather than jumps, never more than a 10-point step - correctly says nothing.
- When the PGN carries clocks, a **card per player** shows how the clock was spent over five buckets, with the longest think named. A clockless game shows nothing.

### Small things that compound
- **Drop a .pgn anywhere** on Analysis or Game Review. The paste box lights up so the file has somewhere visible to land; a drag without files is left alone.
- **Amber warnings** when threads exceed the machine's cores or hash exceeds its memory, on all three pages that take those numbers. Honesty note, written into the module: `navigator.deviceMemory` is spec-capped at 8, so the hash warning only fires when the report is under the cap, where it is a real ceiling.
- **A search box over the settings** - it matches labels *and* tooltips, so "engine strength" finds the Elo cap; sections with no surviving row fold away. Found and fixed in testing: the public build keeps fourteen rows outside any section, so the first version could never hide them - rows are hidden page-wide now, and both builds filter "premove" to the same six rows.
- **A storage readout** in the housekeeping block: "Storage: 207 KB used — of 50.77 GB available", with the IndexedDB slice named as the puzzle database once it is worth naming.
- **The translations**: everything added since v3.1.269 existed in English only. All 23 keys are now in all 13 other locales, tips included, every `{placeholder}` verified intact - and locale completeness is pinned by the test ladder, so a key cannot go missing silently again.

### Known limits
- The tablebase line needs the network (it is lichess's own service); offline it simply stays empty.
- The hash warning cannot fire on machines reporting the 8GB spec cap - that is the API's ceiling, not ours, and the module says so.
- `panic` uses X by default; if you had rebound another action to X, yours wins - defaults never override a saved keymap.

### Downloads
| Archive | Size | Use it when |
|---|---|---|
| `mephisto-3.1.272.zip` | 558 MB | first install |
| `mephisto-3.1.272-update.zip` | 6.0 MB | you already have a build installed |

**Full Changelog**: https://github.com/IchNukeDichWeg/Mephisto/compare/v3.1.271...v3.1.272

---
