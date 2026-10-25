# Cultural Crash-Test — final submission runbook

**Prepared:** 25 October 2026 (IST)  
**Submission deadline:** 30 October 2026, 11:45 PM EDT = **31 October 2026, 9:15 AM IST**  
**Judging period:** 2 November 2026, 12:00 PM EDT through 5 November 2026, 11:45 PM EDT = **2 November, 9:30 PM IST through 6 November, 9:15 AM IST**  
**Finalist obligation:** the top three are expected to present live on 5 November and be available for preparation beforehand.  
**Primary official sources:** [challenge page](https://qloo.devpost.com/) · [official rules](https://qloo.devpost.com/rules) · [Qloo submission guide](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SUBMISSION.md)

This is the ordered plan to take the current repository from its present state to an eligible, judge-ready submission. Do the steps in order. A later step should not be treated as complete while one of its prerequisites is still open.

## 1. What “submitted successfully” means

The entry is not complete merely because the code works locally. It is complete only when all five mandatory deliverables below are present on Devpost and independently verified.

- [ ] A **live, fully published external application** that a judge can use end-to-end.
- [x] A **public source repository** containing the source, assets and setup instructions: <https://github.com/Dhamani-aryan/cultural-crash-test-parallel>.
- [x] An **open-source license** visible in the repository’s About section: MIT is currently visible.
- [ ] An accurate **English text description** explaining the features, functionality and what makes the product Qloo-powered.
- [ ] A completed Devpost entry submitted before **31 October, 9:15 AM IST**.

The 2026 challenge explicitly says that a demo video is **not required**. Do not delay the required live app or submission to make a video. Screenshots or a short optional walkthrough may help presentation, but they are supporting media, not an eligibility requirement.

The live app must remain free and available without restriction until judging ends on **6 November, 9:15 AM IST**. Keeping it active until 16 November is a sensible personal buffer, but it is not the stated judging requirement.

## 2. Current position

Legend: **Complete** is verified now; **open** still requires action; **recheck** exists but must be validated against the release.

| Area | Status | Current evidence or action |
|---|---|---|
| Correct 2026 challenge identified | Complete | Qloo Agentic Hackathon at `qloo.devpost.com` |
| Eligible agentic/Qloo concept | Complete | Parallel user, LLM-only and evidence-agent tracks; Qloo drives the differentiated recommendation |
| Public repository | Complete | `cultural-crash-test-parallel` is public |
| License | Complete | MIT is present and visible in GitHub About |
| Source and setup instructions | Complete | Release README names the live demo, current architecture, environment and validation commands |
| Core implementation | Complete | Parallel engine, Qloo evidence, deterministic gates, stress checks, comparison UI and decision graph are implemented |
| Automated checks | Complete | 44 test files / 468 tests, typecheck, lint and production build passed on 25 October |
| Public production deployment | Complete | <https://cultural-crash-test-parallel.vercel.app> is live and public |
| Production Qloo and model credentials | Complete | Qloo, OpenAI and Brave are configured server-side for Production and Preview |
| Shared production state | Complete | Vercel Upstash is connected for caching, recordings, sessions and rate limits |
| Recorded example runs in production | Open | Warm only after the production environment works |
| Submission description | Complete | `docs/SUBMISSION.md` is rewritten for the live `parallel:v7` release and ready to paste |
| README release accuracy | Complete | README now describes the current parallel architecture, production infrastructure and limits |
| Devpost draft and final submission | Open | Must be completed by the owner |
| Finalist live-presentation readiness | Open | Required only if selected, but preparation should start before submission |

## 3. Priority rule

The official criteria are equally weighted, but **Technological Implementation is the first tie-breaker**. When time conflicts occur, use this order:

1. eligibility and a reliable public deployment;
2. correct, demonstrable Qloo-powered behavior;
3. judge comprehension and product polish;
4. accurate submission copy and evidence;
5. optional media and extra polish.

Do not add a new architecture, broad feature or another full evaluation campaign during the release window. Fix only release blockers, visible judge-flow defects and regressions in the canonical demo path.

## 4. Step-by-step release plan

### Step 1 — Join the event and verify entrant details now

**Owner:** You  
**Deadline:** 25 October

- [ ] Open <https://qloo.devpost.com/> in your normal browser and confirm that the account has joined the hackathon.
- [ ] Confirm the entry is individual or that the correct team representative and members are listed.
- [ ] Confirm you are legally eligible under the official rules and are not in an excluded jurisdiction or conflict category.
- [ ] Create the Devpost project as a **draft now**. Do not wait for deployment.
- [ ] Copy the exact fields shown by the live submission form into a private note. The public rules do not enumerate every UI field, so the form itself is the source of truth for field-level completion.
- [ ] Confirm that you can be available for finalist preparation and a possible live appearance on 5 November.

**Gate:** A Devpost draft exists under the correct entrant identity.

### Step 2 — Freeze the release scope

**Owner:** Code/repository work  
**Deadline:** 25 October

- [ ] Treat `G:\Qloo 2.0-parallel` and <https://github.com/Dhamani-aryan/cultural-crash-test-parallel> as the submission project. Do not submit the legacy repository.
- [ ] Use the current parallel release line (`crash:v15+parallel:v7`) as the release candidate.
- [ ] Write down the release commit SHA before deployment.
- [ ] Permit only blocker fixes after the release candidate is chosen: failed build, broken production authentication, broken Qloo call, misleading result, inaccessible UI or a canonical-demo regression.
- [ ] If a code change alters decision behavior, run the smallest failure-pattern scenario that exercises that change. Do not rerun all 15 scenarios unless a true release-wide change makes it necessary.
- [ ] If a change is presentation-only, run component/unit checks and browser QA; do not spend Qloo/model calls on a new evaluation.

**Gate:** One named release candidate exists and there is no competing “final” branch or repository.

### Step 3 — Perform the repository and legal audit

**Owner:** Code/repository work  
**Deadline:** 26 October

- [ ] Confirm GitHub remains public in an incognito window.
- [ ] Confirm the MIT license remains detectable in GitHub’s About panel. This is an explicit official requirement and is already true today.
- [ ] Confirm every runtime source file, required asset and setup instruction is committed and pushed.
- [ ] Confirm `.env.local`, `.secrets/`, ChatGPT credentials, Qloo keys, Redis tokens, request headers and raw private Qloo responses are not tracked.
- [ ] Search the committed tree for credential patterns and remove/redact any finding before the release.
- [ ] Check third-party packages and assets. Credit permitted libraries; remove any copied image, logo, music or other asset for which the project lacks permission.
- [ ] Use a fictional client brand in the canonical demo. Artist, venue and brand names can be discussed as recommendation data, but avoid copied logos, promotional images and copyrighted music.
- [ ] If any part of the project existed before 30 September 2026, state exactly what substantial Qloo integration was added during the submission period. If it was created during the period, state that plainly.

Run the clean-environment proof from a fresh checkout or temporary directory:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

Record the exact passing test count and release SHA. Do not copy the old “116 tests” claim from `docs/SUBMISSION.md`; use only the count produced by the release candidate.

**Gate:** A stranger can clone, configure, build and test the repository from the README without access to the developer machine.

### Step 4 — Freeze one canonical judge journey and one fallback

**Owner:** Product and code  
**Deadline:** 26 October

Use one scenario for the homepage, submission screenshots and judge rehearsal. The journey must prove the product’s central claim in under two minutes:

1. the user describes a proposed launch naturally;
2. the product forms a brief without repeatedly asking for facts already supplied;
3. the user plan, LLM-only plan and Qloo evidence-agent plan are visibly independent;
4. Qloo evidence changes or validates a concrete decision;
5. the final table states what changed and why;
6. the graph exposes the decision path and evidence without becoming the explanation itself;
7. locks, constraints and uncertainty are handled honestly.

- [ ] Select the canonical London scenario only after it completes correctly on the release candidate.
- [ ] Prefer a scenario with one obvious, evidence-backed improvement and at least one preserved user choice. This demonstrates judgment, not indiscriminate replacement.
- [ ] Ensure the brief uses a fictional launching brand and contains no personal data.
- [ ] Freeze the exact input text. Do not improvise a different prompt during screenshots or judging rehearsal.
- [ ] Select one fallback scenario from a supported city and freeze its exact input too.
- [ ] Record the expected visible path for both scenarios: questions, final selections, status, evidence and graph behavior.
- [ ] Do not use a scenario whose final result is marked Provisional as the main demo unless the human clarification is itself the intended feature demonstration.

**Gate:** The same frozen prompt produces an understandable, honest outcome, and the fallback is ready if live data is temporarily thin.

### Step 5 — Prepare production infrastructure before adding the Qloo key

**Owner:** Deployment work  
**Deadline:** 27–28 October

- [x] Create the production Vercel project from the **parallel** GitHub repository.
- [x] Create the production Upstash Redis database.
- [x] Configure all non-secret environment variables and verify the correct production branch.
- [x] Confirm the app builds on Vercel before the Qloo key is added.
- [x] Confirm the application never sends the Qloo key or model credential to the browser.
- [x] Configure production rate limits, request timeouts and a user-readable error state.
- [x] Decide the stable public hostname that will be submitted. Avoid changing it after the Devpost form is filled.

Expected production variables, reconciled with `.env.example`:

```text
QLOO_API_KEY=<server secret; add on 29 October>
QLOO_BASE_URL=https://hackathon.api.qloo.com
LLM_PROVIDER=openai
LLM_MODEL=gpt-6-luna
LLM_REASONING_EFFORT=low
OPENAI_API_KEY=<server secret>
OPENAI_BASE_URL=https://api.openai.com/v1
BRAVE_SEARCH_API_KEY=<optional server secret for venue verification>
RECOMMENDATION_ARCHITECTURE=parallel
UPSTASH_REDIS_REST_URL=<server secret>
UPSTASH_REDIS_REST_TOKEN=<server secret>
```

`OPENAI_API_KEY` is server-only. The local `CHATGPT_AUTH_FILE` and Redis credential flow are used only when deliberately switching back to `LLM_PROVIDER=chatgpt`. Never paste credentials into source, a screenshot, Devpost text or a client-visible variable.

**Gate:** Vercel builds the correct repository and reaches a safe no-credential/health state before paid or limited credentials are attached.

### Step 6 — Add credentials and make the live deployment functional

**Owner:** You plus deployment work  
**Deadline:** 29 October

- [x] Add the Qloo API key to the production environment as a server-side secret.
- [x] Add the OpenAI API key as a server-side secret and keep `LLM_MODEL=gpt-6-luna`.
- [x] Connect Vercel Upstash and accept its injected `KV_REST_API_*` credentials server-side.
- [ ] If using the ChatGPT fallback instead, sign in only through your normal browser flow and push the credential to Redis with the repository’s credential script. Do not log in through an unfamiliar embedded browser.
- [x] Redeploy after the secrets are configured.
- [x] Verify the public production URL without a developer session.
- [ ] Complete the canonical scenario end-to-end.
- [x] Verify that a judge is not asked to pay, log in, request permission or provide private credentials.
- [x] Verify that credentials remain in server-only variables and are absent from the tracked repository.

**Gate:** An unauthenticated judge can start at the public URL and receive a complete result.

### Step 7 — Run the minimum production validation set

**Owner:** Product QA  
**Deadline:** 29 October

Do not rerun the entire 15-scenario evaluation. Production validation is deliberately small:

- [ ] Canonical scenario: run once live and inspect every screen.
- [ ] Fallback scenario: run once live.
- [ ] One incomplete brief: verify the chat asks only a materially necessary clarification or safely decides when told “decide for me.”
- [ ] One locked choice/hard rule: verify it is preserved or a contradiction is made explicit.
- [ ] One Qloo-unknown choice: verify it is retained and flagged rather than silently “upgraded.”
- [ ] One simulated or controlled API failure: verify a truthful partial/error state, not invented evidence.
- [ ] Mobile width and ordinary desktop width: verify table readability, graph fit and no off-screen controls.
- [ ] Keyboard navigation and reduced-motion mode: verify the comparison remains usable.

Use saved traces and `npm run eval:failures -- <tag>` to identify a representative regression scenario without making new model or Qloo calls. Run a live scenario only when its exact failure pattern could have changed.

After the live checks:

- [ ] Save/warm the canonical and fallback runs in production so judges have a fast, explicitly labelled recorded path.
- [ ] Confirm “run live again” still makes a fresh run.
- [ ] Confirm a recorded result displays its date and never masquerades as fresh evidence.

**Gate:** Both a live run and a labelled recorded replay work from the public deployment.

### Step 8 — Replace stale documentation with release-truthful documentation

**Owner:** Documentation work  
**Deadline:** 29–30 October

Update these files from the release candidate, not from earlier sequential runs:

1. `README.md`
2. `STATUS.md`
3. `docs/SUBMISSION.md`
4. any screenshots or public evidence linked by those files

Required README content:

- [x] one-paragraph problem and product explanation;
- [x] why the application only works well because of Qloo;
- [x] current parallel architecture, without old sequential contradictions;
- [x] supported cities and honest evidence limits;
- [x] clean local setup, environment variables and run instructions;
- [x] exact test commands;
- [x] live demo URL near the top;
- [ ] release screenshots;
- [x] license link;
- [x] no credentials, personal data or raw restricted Qloo responses.

Required submission-copy corrections:

- [x] replace the old repository URL with `cultural-crash-test-parallel`;
- [x] remove the obsolete required-video placeholder;
- [x] remove the stale “116 tests” statement;
- [x] remove stale sequential run-16 metrics from the main claim;
- [x] describe the independent user, LLM-only and evidence-agent tracks accurately;
- [x] describe parallel v7 stability and clarification behavior without claiming certainty where the system says Provisional or Insufficient Evidence;
- [x] use only a metric that can be linked to a named, saved report from the release architecture;
- [x] avoid implying a new release-wide aggregate when the current parallel release has not received one.

The official Qloo guide also asks for:

- [x] a short problem statement;
- [x] the Qloo workflow/tools used and why they fit;
- [x] a redacted workflow explanation, including entity and tag use;
- [ ] a short demo or screenshots containing no credentials or personal data;
- [x] clean-environment setup steps;
- [x] known limitations and what the result does **not** establish.

**Gate:** Every public claim can be traced to the current code, a named result file or a clearly labelled limitation.

### Step 9 — Create the judge-facing evidence package

**Owner:** Product/presentation work  
**Deadline:** 30 October

Although a video is not required, the submission should make the value visible before a judge decides whether to run the app.

- [ ] Capture a clean hero screenshot showing the input/brief in context.
- [ ] Capture the You / LLM / Agent comparison table with one meaningful change visible.
- [ ] Capture the decision graph with all important nodes in view and one detail panel showing evidence.
- [ ] Capture no browser bookmarks, credentials, console, personal data or unrelated tabs.
- [ ] Add concise captions that explain the proof, not decorative slogans.
- [ ] Use the same canonical scenario in all screenshots so the story remains coherent.

Optional only after all mandatory gates pass:

- [ ] Record a 60–90 second silent/captioned or narrated walkthrough of the live app.
- [ ] Do not use copyrighted music or copied promotional media.
- [ ] Treat the live URL—not the video—as the primary demo.

**Gate:** A judge can understand problem → independent plans → Qloo evidence → better/calibrated decision from the page and screenshots alone.

### Step 10 — Write the Devpost entry around the four criteria

**Owner:** You, using the release-accurate draft  
**Deadline:** 30 October

Use a concrete structure instead of a feature dump:

1. **Problem:** small brands and agencies entering an unfamiliar city make interconnected cultural bets that a generic LLM can make sound plausible without local evidence.
2. **Solution:** Cultural Crash-Test treats each pick as a hypothesis, builds independent baselines and tests complete plans with Qloo before recommending a final direction.
3. **What the user does:** describe the launch naturally, confirm the interpreted brief, then inspect the comparison and decision trace.
4. **What Qloo changes:** audience affinities, cross-domain entity relationships, local relevance, explainability and candidate discovery determine which choices survive.
5. **Why it is agentic:** the system plans, gathers evidence, compares candidates, stress-tests the winner, stops or asks for targeted human clarification and records the decision path.
6. **Impact:** reduce culturally generic or mismatched launch choices before a small brand commits venue, talent and collaboration budget.
7. **Proof:** cite one named run and show exactly what Qloo changed or preserved.
8. **Limitations:** aggregate affinity is decision support, not a sales forecast; missing evidence remains missing; Provisional means a human trade-off remains.

Map the product explicitly to the official criteria:

| Criterion | What the judge should see | Repository proof |
|---|---|---|
| Technological Implementation | Real Qloo search/entities/insights/explainability, bounded agent loop, evidence ledger, deterministic constraints and stress checks | `src/lib/qloo/`, `src/lib/crashtest/`, tests and saved evaluation artifacts |
| Design | Natural-language intake, readable three-way table, progressive decision details, fitted/replayable graph and honest error/provisional states | `src/components/`, result route and public deployment |
| Potential Impact | A specific user—small brands/agencies expanding into an unfamiliar city—and a costly decision made before launch | Problem statement, canonical scenario and complete product flow |
| Quality of the Idea | A cultural crash-test rather than another recommendation generator; independent baselines and evidence-backed revision | Parallel architecture, comparison and decision trace |

Avoid these claims:

- “Qloo predicts campaign success.”
- “The recommendation is objectively correct.”
- “The agent always beats the LLM.”
- “No human judgment is needed.”
- Any test count, win rate, request count or cost not produced by the release artifacts.

**Gate:** The description is in English, accurate, concise and explicitly answers why Qloo is indispensable.

### Step 11 — Complete an independent pre-submission audit

**Owner:** You plus one fresh-browser pass  
**Deadline:** evening of 30 October IST

Open everything as a judge with no developer context:

- [ ] Devpost project title, tagline and thumbnail are present.
- [ ] Functional demo URL is correct and HTTPS.
- [ ] Public repository URL points to `cultural-crash-test-parallel`, not the legacy repo.
- [ ] Text description is complete and English.
- [ ] Repository is public, MIT is visible in About and README setup works.
- [ ] Live app requires no payment, login, allowlist or private instruction.
- [ ] Canonical run succeeds in a new incognito session.
- [ ] Recorded fallback is clearly labelled and loads quickly.
- [ ] No field contains “TODO,” “TBD,” “Vercel URL,” “video link” or an old metric.
- [ ] All screenshots load and correspond to the current UI.
- [ ] App title, favicon, metadata, social preview and repository description use the same product name.
- [ ] Mobile and desktop views contain no clipped table, hidden CTA or off-canvas graph node.
- [ ] Browser console contains no release-breaking error.
- [ ] The release SHA is pushed to `origin/main` and the working tree is clean.

Create a release tag only after this audit, for example:

```bash
git tag -a submission-2026 -m "Qloo Agentic Hackathon submission"
git push origin submission-2026
```

**Gate:** Someone using only the Devpost page can reach and understand a working product.

### Step 12 — Submit with a safety buffer

**Owner:** You  
**Target:** **30 October IST**, not the final morning

- [ ] Submit the Devpost entry at least 12 hours before the hard deadline if possible.
- [ ] Re-open the submitted entry and verify that it is marked submitted, not merely saved as a draft.
- [ ] Save a screenshot of the confirmation and the public entry page.
- [ ] Save the exact submitted description, demo URL, repository URL, release SHA and submission time in a local/private note.
- [ ] Re-test both public links immediately after submission.

Official cutoff: **31 October 2026 at 9:15 AM IST**. After the submission period ends, substantive changes to the entry are generally not permitted, so do not plan to finish form content afterward.

**Gate:** There is visible confirmation that the entry was submitted before the deadline.

### Step 13 — Keep the project alive through judging

**Owner:** You and deployment monitoring  
**Window:** submission through 6 November, 9:15 AM IST minimum

- [ ] Keep the Qloo key, model access, Vercel project and Redis database active.
- [ ] Do one lightweight daily health check that does not spend a full scenario’s token/Qloo budget.
- [ ] Keep at least one labelled recorded path available if an external provider is temporarily unavailable.
- [ ] Watch Vercel/Redis error rates without exposing logs publicly.
- [ ] Do not deploy speculative features during judging.
- [ ] If a critical fix is required, preserve the submitted behavior and document the fix and release SHA.
- [ ] Check email and Devpost promptly for finalist or access questions.

**Gate:** Judges encounter the same or a more reliable version of the product described in the entry.

### Step 14 — Prepare for the finalist presentation before notification

**Owner:** You  
**Deadline:** 1 November

Prepare three versions of the story:

- [ ] **20 seconds:** problem, product, why Qloo.
- [ ] **90 seconds:** one input, one Qloo-caused decision, one trace, one impact statement.
- [ ] **3 minutes:** architecture, evidence policy, result, limitations and expansion.

Be ready to answer:

- [ ] Why is this an agent and not a single prompt?
- [ ] What exactly comes from Qloo, and what is an application heuristic?
- [ ] How are the user, LLM-only and agent plans independent?
- [ ] How do you prevent the system from replacing a good but Qloo-unknown user choice?
- [ ] When does it ask a human instead of deciding?
- [ ] What does Stable, Provisional or Insufficient Qloo Evidence mean?
- [ ] How do you know Qloo improved the answer without rigging the comparison?
- [ ] Who pays for this product and what costly decision does it improve?
- [ ] What would be required to expand beyond the supported cities?
- [ ] What can Qloo evidence not prove?

Use `docs/PROJECT_ARCHITECTURE_LEARNING_COURSE.md` as the technical study guide.

## 5. Calendar from today

### 25 October

- Join/verify Devpost and create the draft.
- Freeze the parallel repository and release scope.
- Start learning the architecture and freeze the canonical scenario candidates.

### 26 October

- Complete the repository, secret, license and clean-install audit.
- Run the final local checks.
- Freeze canonical and fallback prompts.

### 27 October

- Create Vercel and Upstash production resources without the Qloo key.
- Fix only deployment blockers or visible judge-flow regressions.
- Draft release-accurate README and Devpost copy.

### 28 October

- Finish deployment plumbing, domain, rate limits and error states.
- Rehearse the canonical flow locally.
- Prepare screenshot framing and submission text.

### 29 October

- Add the Qloo key and production model credential.
- Deploy and run the minimal production validation set.
- Warm the labelled recorded examples.
- Capture release screenshots.

### 30 October

- Update all public documentation and submission copy.
- Run the independent incognito audit.
- Tag the release and submit on Devpost.
- Save submission confirmation.

### 31 October before 9:15 AM IST

- Emergency buffer only. Verify the app and submitted page; do not schedule ordinary implementation work here.

### 1–6 November

- Keep services active.
- Prepare and rehearse the finalist presentation.
- Monitor email, Devpost and production health.

## 6. Final go/no-go checklist

Do not submit while any red item is false:

### Eligibility

- [ ] Joined the correct 2026 Qloo Agentic Hackathon.
- [ ] Correct entrant/team representative.
- [ ] Working agentic application integrates Qloo.
- [ ] Project ownership and third-party licensing are acceptable.

### Required artifacts

- [ ] Fully published external demo URL.
- [ ] Public repository URL.
- [ ] Source, assets and clean setup instructions in the repo.
- [ ] Open-source license visible in GitHub About.
- [ ] Accurate English description.

### Functional proof

- [ ] Judge can use the core flow end-to-end without login or payment.
- [ ] Qloo materially affects a visible decision.
- [ ] App remains honest about missing evidence and uncertainty.
- [ ] Canonical live run and labelled recorded fallback both work.

### Release quality

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] No secrets or restricted raw responses are committed or displayed.
- [ ] README, STATUS and submission copy describe the current parallel release.

### Submission

- [ ] No placeholder or stale URL remains.
- [ ] Entry is submitted, not just drafted.
- [ ] Confirmation is saved.
- [ ] App and required accounts remain active through judging.

## 7. Immediate next three actions

1. **Create and populate the Devpost draft now** so no surprise form field appears on deadline day.
2. **Freeze and verify the release candidate** with the five local commands and select the exact canonical prompt.
3. **Prepare Vercel and Upstash before 29 October**, so adding the Qloo key that day is configuration and validation—not the beginning of deployment work.

