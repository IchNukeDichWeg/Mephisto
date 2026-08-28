# Maia-2

`maia2-rapid.onnx` is **Maia-2 (rapid)** from CSSLab, exported from their released PyTorch weights
with `torch.onnx.export` (opset 17). `maia2-tables.json` carries the two tables the browser needs:
the model's own **1880-move vocabulary** and its **11 Elo buckets** (`<1100`, then hundreds, `>=2000`).

What makes it worth having beside the other two: **it takes both ratings**. Maia-1 is a net per band
and Maia-3 is one slider; Maia-2 answers the same position differently depending on your rating AND
your opponent's, which is what actually changes how a human plays.

- Upstream: https://github.com/CSSLab/maia2 (MIT). Paper: Maia-2, NeurIPS 2024.
- The adapter is `src/offscreen/maia2.js`, and it follows the reference implementation rather than
  improving on it: black-to-move positions are **mirrored** (the net only ever sees White to move)
  and the move mirrored back; the input is 18 planes (12 pieces, turn, 4 castling, en passant); the
  legal mask **multiplies** the logits before a softmax over the whole vocabulary, which is not the
  same as masking with -inf and is what the model's own probabilities mean; the value head is
  `v / 2 + 0.5`, clamped, flipped for Black.
- **Verified against maia2's own PyTorch inference**: 8 positions x 5 rating pairs (including
  asymmetric pairs and Black to move) -> **40/40 on the top move, 40/40 on the top three in order,
  40/40 on the score**. The ONNX export itself was checked against PyTorch separately (30/30 on top
  move and value head). The check runs the SHIPPED adapter, not a copy: `maia-prototype/verify_maia2.mjs`.
