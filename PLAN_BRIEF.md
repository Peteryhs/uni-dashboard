# What to produce

Write a single plan to `docs/PLAN.md`. Nothing else. No code.

You are the planner, and the bar is high: a good engineer should be able to start work
from this document without asking you questions, and should also see that you disagreed
with the obvious approach where the obvious approach is wrong.

## The question being asked

How does all of this come together — as one system that is a website and an Android app,
that takes new data sources and new features cheaply, that looks alive rather than
static, and that reads at a glance.

## Required coverage

Cover each of these explicitly, with your own conclusion, not a menu of options:

1. **Shape of the system.** The handful of parts and what each one owns. Every boundary
   named. Why this shape and not the two nearest alternatives (both of which you should
   name and dismiss).
2. **The contract.** What the pieces exchange, where it is enforced, and what happens
   when a producer and a consumer disagree. What is the one thing that, if you get it
   wrong, makes the rest painful.
3. **Extensibility, in practice.** Peter's explicit need: adding a new data source or a
   new feature later must be cheap. Show the exact shape of that work — what a new source
   is, what a new feature is, and what files it touches. Argue against your own design
   here: where will this leak, and at what count does it break.
4. **Website and Android app from day one.** How both are real, how they stay in step,
   and what each one gets that the other cannot. Do not treat the app as an afterthought.
   If you believe a native app is the wrong call, say so and prove it.
5. **Glanceability and looking alive.** Information design, not decoration: hierarchy,
   density, what is on the first screen, motion, empty and stale states, dark mode. How
   the interface says "this data is 40 seconds old" without words.
6. **Freshness, failure and offline.** Per-source cadence, caching, staleness display,
   what happens when UW is down or a token expires, and what works with no signal —
   which is the normal state of a basement lecture hall.
7. **Cost, honestly.** Free tiers with real limits as of now, and the number that would
   make this cost money. If a choice saves money at the cost of reliability, say so.
8. **Sequencing.** Phases where each phase is independently useful and demonstrable, with
   the smallest first slice that is worth showing to someone. Give an estimate per phase.
9. **Risk register.** The five things most likely to kill or degrade this, each with the
   early signal that it is happening and the mitigation.
10. **Decisions for the owner.** The questions only Peter can answer, each with your
    recommendation and what changes if he answers the other way. Keep it under eight.
11. **What you reject and why.** Including anything you would personally build that the
    requirements above do not justify.

## Standards

- Be specific and opinionated. Name real components with versions where it matters.
- Mark your confidence. If you state a vendor limit, a price, or an API behaviour you are
  not certain of, say so in the line, and say what would confirm it.
- Where `research/Live Data Sources.md` and your own knowledge disagree, the research file
  won't have checked everything. Flag the disagreement and say who is likely right.
- State assumptions instead of asking questions. The owner's decisions belong in section 10.
- Plain English. No filler, no marketing tone, no emoji. Short sentences.
