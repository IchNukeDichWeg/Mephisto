![Mephisto](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

Mephisto is a browser extension for real‑time chess analysis and automated play on **Chess.com**, **Lichess**,
**BlitzTactics**, and **TakeTakeTake**. It reads the position straight off the page, runs a local engine in your
browser, and draws the best moves on the board — or plays them for you, with timing and move choices that can be
tuned to look completely human.

Click Mephisto's toolbar icon to toggle its floating analysis panel directly on the page. The panel drags anywhere
by its title bar, closes with the ✕, and — unlike a classic extension popup — stays open while you click and play,
so analysis and autoplay keep running for the whole game.

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
Fairy‑Stockfish additionally plays **Crazyhouse, King of the Hill, Three‑Check, Antichess, Atomic, Horde, and
Racing Kings**. The **↻** button next to the variant selector detects the variant from the current game and switches
to the right engine automatically.

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

## Supported sites

- **Chess.com** — live games, puzzles, and the **variants** boards (auto‑detect + engine switch).
- **Lichess** — live, correspondence, and "From Position" custom‑start games.
- **BlitzTactics** — puzzle streams.
- **TakeTakeTake** — bot games and online (Lichess‑backed) games, including premoves.

---

## Contributing

Ideas, bug reports, and PRs are all welcome — open an issue or a pull request.
