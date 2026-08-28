# Elite Leela

`elite-leela.onnx` is **Elite Leela v2** (`Elite-Leela-v2-128x10x8h-1704000.pb.gz`) by CallOn84,
converted with lc0's own `leela2onnx`. It is a Leela Chess Zero network trained on the **Lichess
Elite Database** - human games at 2200+ - so it plays like a strong human rather than like a search
engine, which is the point: Maia covers 1100-1900, this covers what a strong club player does.

Run the way Maia is: **one forward pass, no search**. The policy head picks the move, the WDL head
gives the score. Same 112-plane lc0 input and same 1858-move policy order, so it uses the Maia
runner unchanged (`src/offscreen/maia.js`).

- Upstream: https://github.com/CallOn84/LeelaNets (GPL-3.0)
- Conversion: `lc0 leela2onnx --input=Elite-Leela-v2-128x10x8h-1704000.pb.gz --output=elite-leela.onnx`
- **Verified against lc0 itself** (the reference implementation) at `nodes=1`, which is where lc0's
  bestmove IS the policy argmax: **69/70 plies of a self-played game agree**. The single miss is an
  underpromotion against a queen promotion whose policy scores are a hair apart - the same class of
  near-tie as the one miss in the original Maia verification.
- The check lives in `maia-prototype/verify_elite.mjs` and runs the SHIPPED encoder, not a copy of it.
  Note what it had to get right: lc0 must be given the same move history (`position startpos moves
  ...`), because the history planes are part of the input - a bare `position fen` reads 80%.
