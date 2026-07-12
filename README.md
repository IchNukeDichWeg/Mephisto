![alt text](https://raw.githubusercontent.com/AlexPetrusca/Mephisto/master/res/mephisto_banner_lowercase.png)

Mephisto is a browser extension that enables next best move analysis and automated gameplay on Chess.com and Lichess.

## Getting Started

<a href="https://chrome.google.com/webstore/detail/mephisto-chess-extension/ihpdlpgcjepplokoncjelcbbcedgnanp" style="border: 1px solid white">
  <img src="https://github.com/AlexPetrusca/Mephisto/blob/master/res/chrome-web-store.png" align="center" height="66px" />
</a>
&nbsp;&nbsp;&nbsp;&nbsp;
<a href="https://addons.mozilla.org/en-US/firefox/addon/mephisto-chess-extension">
  <img src="https://github.com/AlexPetrusca/Mephisto/blob/master/res/firefox_web_store.png" align="center" height="66px" />
</a>
<br>
<br>

Click Mephisto's icon to toggle its floating analysis panel directly on the page. The panel can be dragged
anywhere by its title bar, closed with the ✕, and — unlike a classic extension popup — it stays open while you
click and play on the board, so analysis and autoplay keep running for the whole game. For ease of use, pin
Mephisto in Chrome's extensions menu: click the puzzle icon to the right of the address bar, find
"Mephisto Chess Extension" and click the pin icon next to it.

For more information, see [Getting Started](https://github.com/AlexPetrusca/Mephisto/wiki/Getting-Started).


## What's New in 3.0.0

**UI**
- **Floating in-page panel** replaces the anchored popup: draggable, closable, and it no longer closes when you
  click the board (the old "Inspect Popup" workaround is obsolete).
- **Quick Settings sidebar** in the panel: Autoplay / Premove / Puzzle / Help toggles apply instantly; engine,
  threads, memory, lines and all timing settings are editable without opening the options page.
- **Evaluation bar** next to the board, shown from your perspective (the text score stays White-relative).

**Engines**
- New builds from `@lichess-org/stockfish-web`: **Stockfish dev NNUE** (new default), **Stockfish 18**
  (dual net — its 104MB net ships split into <50MB chunks and is stitched at load time to fit GitHub's file
  limits), **Stockfish 18 Small** and **Stockfish 17**. Stockfish 6 and 16 were removed; stale selections are
  migrated automatically.
- Illegal scraped positions (missing king, side-not-to-move in check, back-rank pawns) are blocked before they
  can crash the WASM engine, and a crashed engine restarts automatically (capped at 3 attempts).

**Play**
- **Help Mode**: instead of autoplaying, all analysis arrows (best line, alternatives, threat) are mirrored
  directly onto the site's board while the engine keeps evaluating — play the move yourself when ready.
- **Continuous analysis**: with Autoplay off the engine analyzes indefinitely instead of stopping after the
  search time.
- **Safe Premove**: while the opponent thinks, Mephisto certifies a reply to their predicted move (the reply
  must be identical at depth 6, 9 and 10+). If they play exactly that move, the reply is played instantly;
  anything else falls back to a normal search — a wrong guess costs nothing. When the reply could never be
  legal after any other opponent move (forced moves, recaptures), it is queued as a real premove immediately.

**Scraping fixes (2026 site DOMs)**
- Lichess: current obfuscated move-list tags, correspondence games, the game-result element no longer breaks
  parsing, turn detection at the starting position, and mid-animation scrapes are rejected instead of producing
  corrupt positions.
- Chess.com: normal games, "Play Bots", and puzzles all detect correctly (the From-Position support is scoped
  to Lichess so it can't misread a chess.com game's standard start).
- **"From Position" games** (custom starting position, e.g. endgame practice vs the AI) are now supported —
  the starting position is captured at page load and replayed with the moves.
- `remote-engine.py`: opening-book moves are no longer mistaken for game over; undeclared engine options are
  skipped.

**Refinements since 3.0.0**
- **Live depth** in the eval line (counts up like a desktop GUI) and **checkmate vs stalemate** are reported
  correctly for the Remote Engine too.
- **Panel polish**: opens at the top of the page (covers less of the board); Threads, Memory and Multi Lines
  are sliders with live value labels; the options page gained the Premove and Help Mode toggles.
- **Faster premove matching**: the certified reply now matches on the opponent's exact *move* (robust across
  sites) rather than a reconstructed FEN string, which fixed premoves on chess.com.
- **Leela (lc0) removed**: the bundled build was an old, unmaintained port that misbehaved; existing selections
  migrate to the default. (For NN-style analysis, Stockfish dev NNUE covers it.)
- New fresh-install defaults: SF dev engine, 300 ms search, 10 ms fen refresh, 8 threads, 512 MB hash,
  200 ± 50 ms move time, autoplay off.


## How to Develop Locally
Set up a local install:
1. Clone the repo
2. Navigate to `chrome://extensions` through the Chrome address bar
3. Enable developer mode
4. Click on "Load unpacked" and select the cloned repo folder
5. Mephisto Chess Extension is now installed

Test a code change:
1. Navigate to `chrome://extensions`
2. Reload Mephisto Chess Extension
3. Reload the webpage you want to test on
4. Test the changes

For technical details, see [Technical Overview](https://github.com/AlexPetrusca/Mephisto/wiki/Technical-Overview).


## How to Contribute
Thank you for your interest in contributing to Mephisto! There are many ways to contribute, and we appreciate all of them.

Ways to Contribute:
- Help contribute ideas to Mephisto
- Help identify and document bugs with Mephisto
- Implement requested features through PRs
- Fix identified bugs through PRs
