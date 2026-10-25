# Devpost submission draft — Cultural Crash-Test

This document contains release-accurate copy for the Qloo Agentic Hackathon submission form.

## Submission links

- **Live demo:** <https://cultural-crash-test-parallel.vercel.app>
- **Public source:** <https://github.com/Dhamani-aryan/cultural-crash-test-parallel>
- **License:** MIT
- **Video:** not required by this hackathon

## Title and tagline

**Title:** Cultural Crash-Test

**Tagline:** Test the cultural logic of a marketing launch before committing the budget.

## Short description

Cultural Crash-Test is a pre-launch decision agent for marketing teams entering unfamiliar cities. A marketer describes a campaign naturally; the application compares their plan with an independent LLM plan and an evidence-first agent plan, tests every finalist against Qloo's cultural-affinity graph, stress-tests the winner and explains what should stay or change in plain language.

## The problem

A launch plan is a stack of connected cultural bets: an act, a collaboration partner, a venue and a creative direction. A general-purpose language model can make all four sound plausible without establishing whether they fit the intended audience, the city or each other. Marketing teams often discover that mismatch only after talent, venue and production decisions have become expensive.

## What it does

1. The marketer enters the brand, objective, audience, proposed plan and practical constraints in ordinary language.
2. The application freezes a structured brief and states any assumptions.
3. It produces three independent plans: the marketer's plan, an LLM-only plan and a Qloo evidence-agent plan.
4. The agent searches beyond the three displayed finalists, pooling candidates through multiple Qloo retrieval views and testing bounded complete-plan combinations.
5. Every finalist receives the same audience, locality, role, coherence and hard-constraint checks.
6. Anonymous, order-rotated comparisons and evidence stress tests select or qualify the recommendation.
7. A bounded official-source venue check can veto closure, the wrong establishment type, an unsupported event format or insufficient stated capacity. It cannot create a new recommendation or award cultural fit.
8. The interface leads with a marketer-readable explanation, then exposes the comparison table, sources, uncertainties and decision graph for inspection.

## What makes it Qloo-powered

Qloo materially changes the decision. The product uses Qloo Search, Entities and Insights—including tag insights and explainability—to resolve real entities, retrieve culturally related candidates, measure audience affinity, assess local relevance, test plan coherence and map creative directions onto Qloo aesthetics and tones.

The evidence agent never receives the LLM-only draft. It independently searches a broader Qloo candidate pool, screens candidates for the job required by the brief, tests complete bundles and challenges its own weakest choice. The three visible plan columns are finalists, not the whole search.

Missing Qloo data remains unknown. It is not treated as a failure, and the application does not claim Qloo predicts sales or campaign success.

## Why it is agentic

The system does more than produce a recommendation in one prompt. It:

- converts an open-ended brief into explicit decision slots and constraints;
- plans independent evidence work;
- retrieves and resolves entities;
- builds and screens candidate pools;
- tests complete plans rather than isolated names;
- challenges the weakest supported choice;
- compares finalists blind in both orders;
- stress-tests the winner by removing audience anchors;
- applies a deterministic official-source safety gate;
- stops, abstains or asks for human confirmation when evidence is insufficient;
- records the decision path and evidence provenance.

Models perform bounded structured tasks. Code owns validation, budgets, scoring, constraints, operational vetoes and stopping conditions.

## How it was built

- Next.js 16, React 19, TypeScript, Tailwind CSS and Zod.
- OpenAI Responses API for structured drafting, readings and blind comparison.
- Qloo Search, Entities and Insights for cultural evidence and candidate discovery.
- Brave Search for bounded official-source venue verification.
- Vercel Functions and server-sent events for streamed live runs.
- Upstash Redis for shared caching, recorded replays, temporary clarification sessions and rate limiting.
- React Three Fiber and Three.js for the inspectable decision graph.

Production uses `crash:v15 + parallel:v7`, evidence rubric `evidence:v7` and adjudication protocol `adjudicate:v2`.

## Technical implementation

Every plan is converted into a typed evidence matrix. Claims distinguish Qloo evidence, official operational sources, application rules and model readings. Missing measurements are excluded instead of scored as zero. Hard constraints and verified operational contradictions are enforced deterministically.

The release contains 468 automated tests across 44 test files using a synthetic Qloo world. TypeScript, ESLint and the production build passed on the release candidate. Raw Qloo responses and credentials are excluded from the repository.

## Design

The default result is written for a marketer rather than an API developer. It states which original choices survived, what changed, the practical meaning of the evidence and how broad the search was. Technical details remain progressively available through “Why this won,” operational verification and a replayable graph. Unknown evidence is visually distinct from rejection.

## Potential impact

The initial audience is small brands and marketing teams entering a city they do not know well. The tool helps them challenge cultural assumptions before committing venue, partner, talent and production budgets. It is decision support: it narrows and explains the choices that deserve human follow-up rather than claiming to automate taste or predict commercial outcomes.

## Testing instructions for judges

1. Open the live demo; no account or payment is required.
2. Describe a proposed launch naturally, including the brand, objective, city, audience and any current choices.
3. Confirm the interpreted brief.
4. Wait for the streamed live comparison to finish.
5. Read the plain-language recommendation and finalist table.
6. Expand “Why this won” for any choice.
7. Open “View details” to inspect operational sources, stability checks and the decision graph.

The sidebar stores up to 30 briefs only in the judge's browser. Repeating an identical brief may replay a clearly labelled recorded result from the shared production cache.

## Honest limitations

- Qloo affinity is aggregate cultural evidence, not a probability of success.
- A venue recommendation still requires direct confirmation of availability, price and production terms.
- Official-source search can reject a concrete operational conflict but cannot establish live availability.
- Unknown or thin evidence remains visible and may require a person.
- Browser history is not account-based or synchronized across devices.
- The historical evaluation documents an earlier engine; no new release-wide aggregate is claimed for the current parallel release.

## Judging-criteria map

| Criterion | Evidence in the project |
|---|---|
| Technological Implementation | Real Qloo entity, insight, tag and explainability calls; bounded candidate search; shared evidence matrix; blind comparison; stress tests; deterministic constraints and operational gate |
| Design | Natural-language intake, plain recommendation, finalist table, progressive evidence disclosure, responsive graph and honest uncertainty states |
| Potential Impact | A specific pre-spend decision problem for brands and marketing teams launching in unfamiliar cities |
| Quality of the Idea | A cultural crash-test that challenges an existing plan instead of another unexplained recommendation feed |

## Suggested submission images

Use one consistent fictional-brand scenario across all images:

1. Natural-language brief and interpreted plan.
2. Plain recommendation with one preserved choice and one evidence-backed change.
3. Decision graph or expanded venue explanation showing Qloo evidence and the official-source check.

Do not include credentials, dashboards, logs, personal information, copied promotional assets or copyrighted music.
