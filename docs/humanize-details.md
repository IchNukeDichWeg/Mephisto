# Humanize: options and measurements

The full detail behind the [Humanize](../README.md#humanize) section of the README: how each option works and what it was measured against. Moved here from the README unchanged.

**Target accuracy (optional)** aims the game's accuracy at a number you set. Each move is picked by the accuracy it
will itself score (the win chance it gives away, graded the way Live Stats and the Game Review grade it), so the game
closes on the target. Your thresholds still set the limits, and while the game is alive it never plays into a position
worse than -2.5. Measured over 144 simulated games against Stockfish at 1500 and 2200 Elo, scored by the Game Review:
targets of 85 to 95 land within about a point (90 -> 90.0 and 89.8). Lower targets need an opponent who gives chances
back: 75 reached 75.5 against the 1500 but only 83.7 against the 2200. Live on Lichess, targets 90 and 80 came out at
91.4% and 78.8%.

**Guards (on by default)** keep a planned deviation from doing what nobody plays on purpose: hanging a minor piece or
more by exchange count (a pawn en prise stays allowed - that is the error people make), giving back a winning position
(from +3.00 no mistakes or blunders, and nothing below 60% of the eval), or skipping the punishment of a blunder (after
a two-pawn gift the deviation rate drops to a fifth, after a five-pawn one to a twentieth, and a deviation must still
win something). Short mates are always played; a mate in 7 or more is sometimes swapped for a line still at +10.
Winning by +3 to +10, it simplifies like people do: when the engine's move is an even trade, it is kept on 40% of the
moves a deviation was due, so the trade is taken 75% of the time, as players at 1400-1599 take it (it was 57%). The
guards win over Target Accuracy, and the panel says "guard held" when one kept the engine's move. With a Maia option
on, a hang that Maia-3 says players of the Play-like rating really make there (2% or more) is let through: most human
blunders are hung pieces, and these are the natural ones.

**Play like rating** is the one rating for Maia and for the options below. **Scale Errors to the Clock (optional)**
scales the error shares move by move from error rates measured over 2.1 million moves of Lichess games (October 2025,
closed and banned accounts removed): at the same rating, rapid and classical err about as often per move as blitz,
bullet up to 1.9x, ultrabullet up to 2.7x; under 5% of the clock about 1.4x the inaccuracies and 2x the blunders, far
fewer at a full clock. **Human-Like Mistakes (on by default)** draws the deviation by how likely Maia-3 thinks a player of
that rating is to play it, and never a move it gives under 1% (without it, a quarter of the moves played were ones
Maia gives under 1%, against 3% for players). Before move 8 a deviation needs Maia at 5% or more, so the opening
stays a repertoire; without a Maia read the engine's move is played there. **Mistakes Where People Make Them (optional)** moves
the error shares to the positions where Maia sees that rating going wrong, relative to its average this game - not yet
calibrated against real error rates. Both Maia options use the 88 MB Maia-3 net (downloaded the first time) and
standard chess only; until it has answered, the plain pick stands in.

**Err Like Your Rating (on by default)** replaces the sliders with what players of the Play-like rating actually do: each
move's quality is drawn from their measured spread, graded the way the Game Review grades (win% given away), and a
mistake the position cannot offer is owed and played later where one exists. Measured with
`tools/humanize-study/sim-human.mjs` at 1500: 10.0% inaccuracies, 5.4% mistakes, 1.9% blunders per move against the
players' 10.0 / 6.4 / 4.6 (1100: 10.6 / 4.8 / 1.8 against 10.6 / 7.2 / 5.8; 2300: 9.0 / 4.3 / 2.0 against 8.0 / 4.6 /
2.8). The blunder gap is the guards, by design: about half of the players' blunders come where a guard forbids one
(moving into mate, losing over 600cp, or from +3 up), and inside those bounds players at 1400 blunder 2.6% of moves;
with a Maia option on, natural hangs take ours to 2.5. Human-Like Mistakes moves the kind of error toward the players'
(quiet blunders 26% to 46%, players 45%; hung pawns 52% to 37%, players 26%) at 1.7% blunders. Without it, the kind of
error is still drawn from the players' mix at the rating (hung pawn, missed free material, quiet), and a list without
the drawn kind plays a milder move and owes the error: at 1500, hung pawns went from 28% to 22% of the inaccuracies
(players 14%) and from 39% to 24% of the mistakes (players 22%); blunders are still about half hung pawns (players 26%). Inside that kind it prefers
an error that still looks fine two moves deep, the miss a person makes: players' errors are like that far more often
than an engine list's (1400: 28 / 16 / 10% of inaccuracies / mistakes / blunders, more at higher ratings), and at 1500
ours went from 18 / 5 / 0% to 18 / 9 / 5%. The default sliders,
for comparison, measure 1.0 / 0.0 / 0.4; they still apply with this option off, and an install whose mix was tuned
before 3.1.323 keeps it off. **Think Like Your Time
Control (optional)** draws each think from how long players spent per move at that time control, phase and clock
left, about 2% of the game per blitz move, much less with the clock running out - with a person's spread. A move it is
about to get wrong takes longer, as people's do: in blitz a blunder about 1.4x an average move, a good move 0.9x. And
the thinks run in streaks, a fast stretch then a slow one (lag-1 correlation 0.17 in blitz, as measured). No think
takes more than half the clock left (players' p99 above 5% of the clock).
