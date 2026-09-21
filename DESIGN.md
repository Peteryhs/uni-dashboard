# DESIGN.md

Direction and visual identity for Uni Dashboard (Waterloo Student Life).

- **Product**: Personal glanceable live student life dashboard for University of Waterloo.
- **Audience**: Waterloo student balancing class schedule, dining hall menus, and deadlines.
- **Personality**: Calm, utilitarian, immediate, trustworthy, grounded in campus realities.
- **Dial**: ENERGY 1 / RHYTHM 2 / MOTION 1
  - **ENERGY 1**: Calm, high signal-to-noise ratio, glanceable in 3 seconds before leaving for class.
  - **RHYTHM 2**: Responsive 12-column desktop grid with varied card weights (Next Class & Dining highlighted, Due Soon & Alerts focused).
  - **MOTION 1**: Fast micro-transitions on hover/focus states only. No floating animations, no bouncing, no breathing background blobs.
- **Palette**:
  - Background base: `#090a0f` (Rich dark slate)
  - Card surfaces: `#12151e` (Crisp solid elevation)
  - Card borders: `#222736` (Subtle boundary, 1px solid)
  - Text primary: `#f4f4f5` (Zinc-100, contrast > 18:1 against card)
  - Text secondary: `#a1a1aa` (Zinc-400, contrast > 7.5:1 against card)
  - Campus Accent: `#f59e0b` (UW Gold / Amber, used sparingly for priorities and location markers)
  - Live status: `#10b981` (Emerald green for active fresh data and open venues)
- **Typography**: Inter / system sans with tabular figures (`tabular-nums`) for countdowns and times.
- **Focal Point**: The Next Commitment card, then the dining recommendation, then Due Soon. The
  alert banner sits above the grid and never competes for weight.
- **Hierarchy rule (one line, per R-31)**: visual weight follows how soon the content expires. The
  next class earns an accent border and the largest type; deadlines weigh less; the food card weighs
  least because it is browsed, not raced. That is the one reason the cards are allowed to differ in
  size, and it is why a uniform grid would be wrong here.
