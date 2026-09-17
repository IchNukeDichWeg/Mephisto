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
