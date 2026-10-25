# Cultural Crash-Test — release status

**Updated:** 25 October 2026

**Deadline:** 30 October 2026, 11:45 PM EDT / 31 October 2026, 9:15 AM IST

**Live demo:** <https://cultural-crash-test-parallel.vercel.app>

**Repository:** <https://github.com/Dhamani-aryan/cultural-crash-test-parallel>

**Current release:** `crash:v15 + parallel:v7`

## Release state

| Area | Status | Evidence |
|---|---|---|
| Public production deployment | Complete | Vercel production alias responds successfully over HTTPS |
| Production intake | Complete | Public `/api/intake` returned HTTP 200 after the final configuration |
| Qloo, OpenAI and Brave configuration | Complete | Server-only Production and Preview variables configured in Vercel |
| Shared production cache and rate limiting | Complete | Vercel Upstash integration connected; app supports injected `KV_REST_API_*` names |
| Public repository | Complete | Parallel repository is public and `main` is current |
| Open-source license | Complete | MIT license committed |
| Automated release checks | Complete | 44 test files / 468 tests, TypeScript, ESLint and production build passed on 25 October |
| Secret hygiene | Complete | `.env*`, `.secrets/`, `.vercel/`, raw Qloo responses and local evaluation output are ignored |
| README and submission copy | Complete | Updated for the live parallel release; no required-video or legacy-repository claims |
| Canonical production scenario | Open | Freeze and run one judge-facing prompt end-to-end in production |
| Fallback production scenario | Open | Freeze one alternative supported-city prompt and warm its recorded replay |
| Devpost draft | Owner action | Join the event and populate the submission form |
| Devpost final submission | Owner action | Submit before the deadline and preserve confirmation |

## Current product

The production application compares three independent complete plans: the marketer's stated plan, an LLM-only plan and one evidence-first agent plan. The evidence agent searches a broader Qloo candidate pool, screens candidates against the brief, tests bounded complete-plan combinations and challenges its own weakest choice. All finalists are tested through the same evidence matrix and compared anonymously in both orders.

The result explains in ordinary marketing language what was kept, what changed and why. Technical evidence, operational sources, stress checks and the decision graph remain available behind details. A bounded official-source venue check may reject a concrete operational conflict, but cannot invent a replacement or override cultural scores.

## Infrastructure behavior

- Qloo responses are cached server-side for 24 hours.
- Completed identical runs can replay from Redis for 14 days and are labelled recorded.
- Clarification sessions expire after two hours.
- Live crash tests are limited to three per public IP per ten minutes; intake is limited to thirty messages per IP per ten minutes.
- Each visitor's sidebar history stays in that browser and is not shared with other judges.

## Remaining release work

1. Freeze the exact canonical and fallback prompts.
2. Run those two flows on the public deployment and inspect the final explanation, operational check and graph.
3. Capture three clean screenshots from the canonical story.
4. Create and populate the Devpost draft using [`docs/SUBMISSION.md`](docs/SUBMISSION.md).
5. Verify the demo and repository from an incognito browser.
6. Tag the final submission commit and submit at least several hours before the deadline.
7. Keep Vercel, Upstash and API access active through the judging period.

## Known limits

- Cultural affinity is decision support, not a sales or attendance prediction.
- Live venue availability, willingness, price and detailed production suitability remain human checks.
- A Qloo-unknown but plausible choice is retained and flagged rather than treated as bad.
- No account-based or cross-device brief history is implemented.
- The previous nine-brief evaluation remains historical evidence for the earlier engine; no new release-wide aggregate is claimed for the current parallel version.
