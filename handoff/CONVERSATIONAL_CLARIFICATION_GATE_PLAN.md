# Conversational clarification gate — implementation plan

**Status:** plan only; do not implement or run paid evaluation until reviewed.

## Product objective

The app should behave like a normal chat. A user writes a natural-language launch brief and presses the existing run/start action. The system begins understanding the request immediately. If it has enough information, it runs without interrupting. If one or two unresolved decisions could materially change the recommendation, the assistant asks concise clarification inside the same chat using radio buttons, checkboxes or free text. The user may always say **Decide for me**, after which the system records an explicit assumption and proceeds.

This is human-in-the-loop intent collection, not a replacement for the agent and not an excuse to avoid a recommendation. The app must still reach a conclusion.

## Non-negotiable behaviour

1. **No questionnaire before every run.** Most clear briefs continue immediately.
2. **Ask only material questions.** The answer must be capable of changing candidate eligibility, a hard/soft constraint, or the winning complete plan.
3. **At most two clarification turns and three questions total.** Default to one high-value question at a time.
4. **Always provide an escape hatch:** `Decide for me` / `I’m not sure`.
5. **Always conclude.** After the question budget is exhausted, freeze explicit assumptions and run.
6. **Do not lead the user toward candidates.** Ask about intent and trade-offs, not “Would you like Brand X?” after seeing Qloo results.
7. **The same clarified brief goes to U, L and A.** Clarification cannot secretly favour the Qloo agent.
8. **Unknown is not failure.** Qloo absence alone never triggers a question unless identity or a user requirement cannot otherwise be interpreted.
9. **No hidden assumptions.** Every assumption introduced by `Decide for me` appears in the transcript and result.
10. **No new multi-agent architecture.** This is a stateful chat/intake workflow feeding the existing single recommendation agent.

## User experience

### Clear brief

```text
User
We are launching … [brief]

Assistant
I have enough to work with. I’ll treat Princess Nokia as preferred, keep the
pop-up in the Lower East Side, and explore the other choices.

[Run begins]
```

Do not show a clarification card merely to confirm facts already explicit in the brief.

### Material ambiguity

```text
Assistant
One thing could materially change the plan:

How strict is the Lower East Side location?

○ It must be in the Lower East Side
○ Nearby downtown Manhattan is acceptable
○ Anywhere in New York is acceptable
○ Decide for me

[Add your own answer…]
```

After the answer:

```text
User
It must be in the Lower East Side.

Assistant
Got it. I’ll treat the Lower East Side as required. I have enough information now—running the comparison.
```

### Multiple compatible requirements

Use checkboxes only when more than one option may apply:

```text
Which qualities must the collaborator have? Select any that are required.

□ Locally founded
□ Independent rather than a global label
□ Strong audience affinity
□ Experience with art or cultural projects
□ None are required—decide for me
```

### Free-text answer

Every card includes an optional text field: `Give your own answer…`. A normal chat message also answers the active question; the user is never forced to use the controls.

### User does not know

```text
User
I don’t know—decide for me.

Assistant
I’ll treat local cultural relevance as preferred, not mandatory, and I’ll flag an international choice if it wins. Running now.
```

## What may trigger clarification

Questions are allowed only for one of these material conditions.

### 1. Choice strength is ambiguous

The brief names an artist, brand, venue or direction but does not reveal whether it is:

- fixed;
- preferred but replaceable;
- merely being considered;
- an example rather than a choice.

Ask only if treating it differently could change the final plan. Phrases such as “must,” “booked,” “already confirmed,” “keep,” “possibly,” “considering” and “open to alternatives” should normally resolve this without asking.

### 2. Two instructions conflict

Examples:

- “Use a global headline artist” and “do not let celebrity dominate.”
- “Venue is booked” and “find a better venue.”
- “Must be in Bondi” and “any Sydney waterfront location is fine.”

Ask which instruction has priority.

### 3. A geographical boundary changes eligibility

Examples:

- a named neighbourhood with no indication whether it is mandatory;
- “local brand” without knowing whether local means founded there, culturally relevant there, or physically nearby;
- city versus metro-area flexibility.

### 4. Event/venue role is materially unclear

Ask when the brief could mean fundamentally different event formats—for example retail pop-up versus gallery exhibition versus performance/nightlife venue—and that difference changes which places can do the job.

Do not ask generic capacity/availability questions on every run. Those stay as human checks in the result unless the user made capacity or booking status essential.

### 5. A subjective trade-off will decide between strong plans

Allowed trade-offs include:

- local specificity versus broader audience reach;
- independent/distinctive versus familiar/mainstream;
- preserving the user’s current concept versus exploring alternatives;
- product focus versus spectacle;
- evidence strength versus novelty.

Ask only when the system can show that two otherwise viable plan directions differ on that trade-off. Do not name the candidate plans or brands in the question.

### 6. Named-entity identity cannot be resolved safely

Examples:

- two artists or brands share a name;
- the named venue exists in several cities;
- the user’s brand is confused with an existing Qloo entity.

Ask a short identity question. If the user says `Decide for me`, keep the item unresolved and flagged rather than silently selecting a namesake.

### 7. A free-text hard rule cannot be interpreted confidently

Ask only when the rule changes eligibility and has multiple plausible meanings. If code simply cannot verify a clear rule (availability, sustainability certification, willingness to collaborate), do not ask the user to prove it during intake; preserve it as an external human check.

## What must not trigger clarification

- Qloo returns no affinity for one otherwise valid choice.
- A recommendation has thin rather than strong evidence.
- The agent wants additional demographic detail that is not necessary to proceed.
- A venue’s capacity, availability or commercial willingness is unknown but was not a hard requirement.
- The agent can safely make a reversible/default assumption and disclose it.
- The question merely improves prose or makes the brief more detailed.
- The system is trying to steer the user toward a candidate it already retrieved.
- The clarification budget is exhausted.

## Decision policy

Clarification is a code-controlled gate. The model may propose a question, but code decides whether it is permitted.

For every proposed uncertainty, record:

- what is uncertain;
- which brief phrases created it;
- affected fields/slots;
- the two or more interpretations;
- whether candidate eligibility changes;
- whether a hard/soft constraint changes;
- whether a plausible winner could change;
- the safe default if the user delegates;
- confidence and limitations.

Ask only when at least one of these is true:

1. interpretations produce different eligible candidate sets;
2. interpretations produce different locked/preferred/open states;
3. interpretations change the required venue/event role;
4. interpretations can reverse the ordering of two viable complete-plan directions;
5. entity identity is ambiguous and choosing silently risks the wrong real-world entity.

Otherwise, proceed with an explicit assumption.

### Priority order

When several questions qualify, ask in this order:

1. conflicts and hard constraints;
2. entity identity;
3. fixed/preferred/considered choice strength;
4. geography and event format;
5. subjective trade-off between viable directions.

Choose the question with the greatest expected impact on candidate eligibility or winner selection. Combine questions only when they concern the same decision.

## Bounded dialogue state machine

```text
drafting
  ↓ user asks to run
understanding
  ↓
preflight_resolution  (brief parsing + cheap named-entity/market checks)
  ├─ material uncertainty → awaiting_clarification
  │                           ↓ answer / custom text / decide for me
  │                     apply_clarification
  │                           ↓
  │                     understanding or ready
  └─ no material uncertainty → ready
                                  ↓
                           freeze_clarified_brief
                                  ↓
                           running_u_l_a
                                  ↓
                         result | provisional_result
```

Limits:

- `maxClarificationTurns = 2`
- `maxQuestionsTotal = 3`
- `maxQuestionsPerTurn = 2`, but default is 1
- after the budget: `Decide for me` behaviour is applied automatically, assumptions are recorded, and the run proceeds
- no transition from `running_u_l_a` back into an unlimited intake loop

### Deep-run uncertainty

P0 should not pause an expensive run halfway through. Perform brief parsing, named-entity resolution and the clarification checkpoint before U/L/A generation. If later Qloo evaluation finds thin evidence, an unverifiable real-world fact or an unstable verdict, return a conclusion marked provisional with specific human checks.

A resumable mid-run clarification protocol is P1 only if real usage proves preflight is insufficient. Do not introduce server-side session persistence for it now.

## Structured data model

```ts
type ClarificationInputKind = "single_choice" | "multi_choice" | "free_text";

interface ClarificationOption {
  id: string;
  label: string;
  value: string;
  consequence: string; // internal/audit text, not generic UI microcopy
}

interface ClarificationQuestion {
  id: string;
  reason:
    | "conflict"
    | "entity_identity"
    | "choice_strength"
    | "geography"
    | "event_format"
    | "tradeoff"
    | "rule_meaning";
  prompt: string;
  inputKind: ClarificationInputKind;
  options: ClarificationOption[];
  allowCustom: true;
  allowDelegate: true;
  affectedSlots: Slot[];
  sourcePhrases: string[];
  materialEffect: string;
  delegatedAssumption: string;
}

interface ClarificationAnswer {
  questionId: string;
  selectedOptionIds: string[];
  customText?: string;
  delegated: boolean;
  answeredAt: string;
}

interface ClarificationSession {
  sessionId: string;
  state: "understanding" | "awaiting_clarification" | "ready" | "running" | "complete";
  originalMessage: string;
  briefDraft: LaunchBriefInput;
  questionsAsked: ClarificationQuestion[];
  answers: ClarificationAnswer[];
  assumptions: string[];
  turnsUsed: number;
  clarifiedBriefFingerprint?: string;
}
```

Persist the transcript-facing question and answer in the client conversation state. Do not put secrets or raw provider output in it. For the current single-user demo, the server can re-parse the accumulated trusted chat/answers rather than introducing a database. Cache only non-secret structured state using the project’s existing cache abstraction where appropriate.

## Applying answers

Each option maps to a deterministic patch on the structured brief:

- add/remove a slot lock;
- mark a choice fixed/preferred/considered;
- add a geographic constraint;
- select an event format;
- add a positive or negative quality;
- set a ranked trade-off;
- disambiguate an entity with country/city/type metadata;
- record a delegated assumption.

After applying an answer:

1. display a short chat acknowledgement;
2. recompile the intent contract;
3. run the clarification gate again within the remaining budget;
4. freeze the final brief and its fingerprint;
5. give the identical clarified brief to U, L and A.

Never edit the user’s original message. Store clarification patches and assumptions separately for auditability.

## Chat UI

### Components

- `ClarificationMessage`: ordinary assistant chat bubble containing the concise question.
- `SingleChoiceClarification`: radio group.
- `MultiChoiceClarification`: checkbox group with validation for conflicting options.
- `FreeTextClarification`: one-line or compact multiline input.
- `DelegateOption`: visually equal option labelled `Decide for me` or `I’m not sure—use your best judgment`.
- `ClarificationComposer`: accepts either control selection or a normal typed answer.
- `ClarificationReceipt`: compact user answer shown in the transcript.

### Interaction rules

- Controls are embedded in the chat, not presented as a modal that blocks the entire interface.
- Keyboard and screen-reader support is required.
- One prominent `Continue` action; Enter submits free text when appropriate.
- The normal message composer remains usable and can answer the active question.
- If the user changes the subject, do not misinterpret it as an answer; retain the pending question and interpret the new message normally.
- On submission, disable only that card to prevent duplicate answers and show the selected answer in the transcript.
- Do not add generic helper descriptions or excessive borders/highlights. Reuse the app’s established rounded, restrained visual language.
- Do not display internal confidence percentages or reasoning traces.

## API and streaming contract

Extend the existing intake/chat stream with explicit events rather than parsing assistant prose:

```ts
type IntakeEvent =
  | { type: "assistant_message"; text: string }
  | { type: "clarification_required"; session: PublicClarificationSession; questions: ClarificationQuestion[] }
  | { type: "clarification_applied"; sessionId: string; acknowledgement: string; briefDraft: LaunchBriefInput }
  | { type: "ready"; sessionId: string; clarifiedBrief: LaunchBriefInput; fingerprint: string; assumptions: string[] }
  | { type: "run_started"; runId: string }
  | existingRunEvents;
```

Add one answer action/endpoint that accepts the session ID plus structured or free-text answers. Validate question IDs, allowed option IDs, question budget and session state. Replaying the same answer must be idempotent.

The client starts the crash test automatically on `ready` unless the user explicitly asked to review the interpreted brief first.

## Clarification generator

Use one bounded structured model call after deterministic parsing and cheap entity resolution. Inputs:

- original user message;
- current structured brief;
- intent contract with cited phrases;
- deterministic conflicts/unknown identities;
- question/turn budget remaining.

Output a list of proposed uncertainties/questions following the schema. Code then filters them through the materiality policy, removes duplicates, checks non-leading wording and selects at most the allowed count.

The generator must not receive Qloo candidate names or rankings. This prevents questions from becoming a mechanism to steer the user toward the agent’s preferred answer.

If the model call fails or returns invalid output, continue with deterministic assumptions and disclose them; do not block the product.

## Conclusion and result behaviour

The app remains useful even when uncertainty remains.

### Final result

Use when the clarified brief, constraints and evidence are sufficient. Show U/L/A/final comparison normally.

### Provisional result

Use when the system had to delegate a material choice, Qloo coverage is thin, entity identity remains unresolved, feasibility requires external confirmation or blind adjudication is unstable.

Still provide the best current plan. At the top show only the specific assumption/check that could change it, for example:

> Provisional: you asked us to choose how strict “local” should be. We treated locally relevant as preferred, not mandatory.

Do not replace the result with an endless “we need more information” screen.

## Evaluation plan

Clarification quality and recommendation quality are separate evaluations.

### Frozen clarification set

Before implementation results are seen, create a reviewed fixture set containing:

- clear briefs that must run without a question;
- genuinely ambiguous briefs requiring one question;
- conflicting briefs;
- ambiguous entity identities;
- a user answer using buttons;
- a free-text answer;
- `I don’t know / decide for me`;
- a failed clarification model call;
- attempts to ask unnecessary demographic or feasibility questions;
- attempts to ask leading candidate-specific questions.

Each fixture records acceptable question reasons, forbidden questions, the deterministic default and the expected clarified-brief patch. Avoid specifying exact prose unless necessary.

### Existing 15 scenarios

Do not use the current 15 final recommendations to tune questions after the fact. Have a human review each original brief before running the new system and label only:

- `clear — run immediately`; or
- the material ambiguity category and acceptable answer options.

Freeze those labels and answers before the next recommendation comparison. Then evaluate:

1. whether the gate asked only when expected;
2. whether it asked the correct material question;
3. whether button/free-text/delegated answers patched the brief correctly;
4. recommendation quality after the same clarified brief was given to U/L/A.

### Metrics

- unnecessary-question rate on clear briefs;
- material-ambiguity detection rate;
- clarification reason accuracy;
- average questions and turns per run;
- percentage reaching `ready`;
- percentage reaching a conclusion after `Decide for me`;
- answer-to-brief patch accuracy;
- candidate-name leakage in questions (must be zero);
- U/L/A clarified-brief fingerprint equality;
- post-clarification hard violations, stability, support and blind human preference;
- added model calls, latency and abandonment.

### Acceptance gates

1. 100% of clear fixtures run without an unnecessary blocking question.
2. 100% of conflict/entity-identity fixtures ask or safely preserve an unresolved choice.
3. No run exceeds two clarification turns or three questions.
4. `Decide for me` reaches `ready` and then a result in every fixture.
5. Zero candidate-name leakage or leading candidate-specific questions.
6. Every answer produces the expected deterministic brief patch and audit record.
7. U, L and A receive the same final clarified-brief fingerprint.
8. Clarification failure never prevents a conclusion.
9. Existing intake, streaming, cancellation, rate-limit and recording tests remain green.
10. Human review is required before claiming that clarification improves recommendation quality.

## Implementation phases

### P0 — policy and fixtures

1. Add clarification types and schemas.
2. Create and human-review the frozen clarification fixture set.
3. Add deterministic materiality checks for conflicts, identity, choice strength, geography and event format.
4. Implement structured question proposal plus code filtering.
5. Test that clear briefs do not trigger questions.

### P1 — chat loop

1. Add the bounded clarification session state machine.
2. Add `clarification_required`, `clarification_applied` and `ready` stream events.
3. Add the answer action with idempotency and validation.
4. Apply deterministic brief patches and record assumptions.
5. Automatically continue into the existing U/L/A run on `ready`.

### P2 — interface

1. Render clarification as ordinary assistant messages.
2. Add radio, checkbox, free-text and delegate controls.
3. Allow normal composer messages to answer an active question.
4. Show the answer and acknowledgement in the transcript.
5. Verify keyboard, mobile and screen-reader behaviour.

### P3 — evaluation

1. Pass unit, integration, component, server, typecheck, lint, build and diff checks.
2. Run the frozen clarification fixtures.
3. Have a human label clarification needs for the 15 scenarios before running recommendations.
4. Run the clarified scenarios in a new versioned output directory.
5. Compare recommendation quality separately from clarification quality.
6. Do not change the default architecture or merge a superiority claim automatically.

## Tests required

- Clear brief produces `ready` without `clarification_required`.
- “Booked venue” becomes a lock without asking.
- “Considering venue” is classified as considered; ask only if its strength could change the winner.
- Conflicting venue instructions produce one priority question.
- Ambiguous namesake produces an identity question.
- Missing Qloo affinity alone produces no question.
- Generic feasibility unknown produces a result-time human check, not an intake interruption.
- Single-choice, multi-choice and free-text answers apply the correct patches.
- A normal typed chat message answers the active question.
- `Decide for me` records the declared assumption and proceeds.
- Duplicate answer submission is idempotent.
- Invalid option/question/session IDs are rejected.
- Maximum question/turn budgets cannot be exceeded.
- Failed generator call proceeds with explicit assumptions.
- Questions never contain Qloo candidate names/ranks.
- U/L/A receive identical clarified brief and fingerprint.
- Unresolved material uncertainty produces a provisional result, not an empty screen.
- Existing cancellation and retry behaviour remains correct.

## What to retain and what to stop

Retain from v3:

- evidence ledger and explicit unknown/support/contradiction states;
- Qloo entity resolution and namesake protection;
- role/locality/brief screens where they are deterministic and auditable;
- U/L/A comparison UI and blind evaluation tools;
- frozen artifacts, fingerprints and overwrite guards.

Do not continue adding ranking weights or scenario-specific rules to rescue v3. The next improvement is better intent certainty before recommendation, followed by simpler evidence-grounded planning and honest evaluation.

