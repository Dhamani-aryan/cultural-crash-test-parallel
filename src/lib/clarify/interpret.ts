import type { ClarificationQuestion } from "./types";

/**
 * Read a typed chat message as an answer to the open question, deterministically. A message that
 * delegates delegates; one that clearly matches one option selects it; one that talks about the
 * question in other words is kept verbatim as a custom answer; one that doesn't touch the question
 * at all is not an answer, so the question stays open and the message is left for normal handling.
 */
export type Interpretation =
  | { kind: "delegate" }
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "unrelated" };

const DELEGATE = /\b(decide for me|you decide|your call|up to you|i'?m not sure|not sure|no idea|i don'?t know|dont know|whatever you think|use your (?:best )?judg(?:e)?ment|you choose|surprise me)\b/i;
const STOP = new Set(
  "a an the is it its it's be to of in on at for and or but if so as we our us i you your my me this that these those with without just only any some all can could should would will do does not no yes than then more most less very really also about from into out up down by how what when where which who whom why there here".split(" "),
);
/** Generic phrasings of the same answer, folded before matching. */
const SYNONYMS: [RegExp, string][] = [
  [/\b(?:has|have|needs?|got) to\b|\brequired\b|\bmandatory\b|\bstrictly\b/g, " must "],
  [/\bclose to\b|\bnear(?:by)?\b|\bnext to\b|\baround\b/g, " nearby "],
  [/\b(?:fine|ok|okay|good|works)\b/g, " acceptable "],
];
const words = (s: string) =>
  SYNONYMS.reduce((t, [re, to]) => t.replace(re, to), s.toLowerCase().replace(/[’']/g, ""))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));

export function interpretText(q: ClarificationQuestion, text: string): Interpretation {
  const t = text.trim();
  if (!t) return { kind: "unrelated" };
  if (DELEGATE.test(t)) return { kind: "delegate" };
  const said = new Set(words(t));
  // Best option by the share of its own distinguishing words the message uses (words the question
  // itself uses, like the place it asks about, say nothing about which option); a clear winner selects it.
  const asked = new Set(words(q.prompt));
  const scored = q.options
    .map((o) => {
      const label = [...new Set(words(o.label))];
      // When every word of an option is also in the question, what sets it apart from the other options decides.
      const others = new Set(q.options.filter((x) => x !== o).flatMap((x) => words(x.label)));
      const fresh = label.filter((w) => !asked.has(w));
      const own = fresh.length ? fresh : label.filter((w) => !others.has(w));
      const hit = own.filter((w) => said.has(w)).length;
      return { o, score: own.length ? hit / own.length : 0, hit };
    })
    .sort((a, b) => b.score - a.score || b.hit - a.hit);
  const [best, next] = scored;
  if (best && best.score >= 0.5 && best.hit >= 1 && (!next || best.score - next.score >= 0.2)) return { kind: "option", optionId: best.o.id };
  // Talks about the question (its prompt, options or the brief words behind it): a custom answer.
  const topic = new Set(words([q.prompt, ...q.options.map((o) => o.label), ...q.sourcePhrases].join(" ")));
  if ([...said].some((w) => topic.has(w))) return { kind: "custom", text: t };
  return { kind: "unrelated" };
}
