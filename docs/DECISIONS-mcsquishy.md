# McSquishy product decisions

This note is the canonical reference for the first playable level. It turns
the product decisions from issue #2 into implementation guidance for the
player, level, hazard, rendering, and game-state work.

## Visual style and squash-and-stretch

McSquishy uses a cartoonish, playful visual style with colourful, simple
shape/vector-style placeholder art. The presentation should remain light,
approachable, and slightly absurd rather than aiming for realism or detailed
art assets.

McSquishy is rendered as a jelly-like blob with visible squash-and-stretch
reactions:

- On jump launch, stretch vertically and narrow horizontally.
- On landing, squash vertically and widen horizontally.
- Ease each reaction over approximately 100 ms, then return smoothly to the
  normal shape.

The duration and scale amounts are implementation placeholders that can be
tuned during playtesting; the direction and brief, readable reaction are the
decisions that downstream work must preserve.

## Lives and failure model

Each level attempt starts with **3 lives**. Contact with a hazard or falling
outside the playable level consumes one life and restarts McSquishy at the
level's defined starting position. When all 3 lives have been lost, the game
enters its game-over/failure state and must offer a way to start a fresh
attempt with 3 lives.

## Checkpoint policy

The first playable level has **no checkpoints**. Every failure restarts from
the level's defined starting position; no progress position is retained.

## Movement feel and placeholder defaults

Movement should feel responsive and suitable for timing-focused platforming:
high jumps, good horizontal speed, and snappy acceleration/deceleration. The
following are concrete starting defaults for a pixel-based canvas coordinate
system. Positive vertical velocity points down, so the jump impulse is
negative:

| Parameter | Placeholder default | Purpose |
| --- | ---: | --- |
| Gravity | `1800 px/s²` | Strong, readable return to the ground |
| Jump impulse | `-700 px/s` | High initial jump velocity |
| Maximum horizontal speed | `320 px/s` | Fast traversal without losing control |
| Horizontal acceleration | `2400 px/s²` | Snappy response to directional input |
| Horizontal deceleration | `2800 px/s²` | Quick stopping and direction changes |

These numeric values are adjustable placeholders, not a final tuning
commitment. Playtesting may change them while preserving the intended
direction: high jump, fast horizontal movement, and responsive control.

## Scope and adoption

This note records product decisions only. It does not require rendering,
physics, level, hazard, or UI implementation in this issue. Those systems
should reference this note rather than independently redefining these
behaviours.
