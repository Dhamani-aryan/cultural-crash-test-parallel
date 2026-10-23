"use client";

import { useId, useState } from "react";
import type { PublicQuestion } from "@/lib/clarify/session";
import { DELEGATE_LABEL, answerFromSelection, type Selection } from "./clarify-view";

/**
 * Clarification questions as part of the assistant's turn: the question is the assistant's text,
 * the options native radios (one answer) or checkboxes (several), with "Decide for me" as an equal
 * option. The typed composer can answer too; this card is only the quicker way.
 */
export function ClarificationCard({
  questions,
  disabled,
  onAnswer,
}: {
  questions: PublicQuestion[];
  disabled: boolean;
  onAnswer: (answers: NonNullable<ReturnType<typeof answerFromSelection>>) => void;
}) {
  const [sel, setSel] = useState<Selection>({});
  const base = useId();
  const ready = answerFromSelection(questions, sel);
  const pick = (q: PublicQuestion, optionId: string | null, on: boolean) =>
    setSel((s) => {
      const cur = s[q.id] ?? { optionIds: [], delegated: false };
      // "Decide for me" stands alone: choosing it clears the options, and an option clears it.
      if (optionId === null) return { ...s, [q.id]: { optionIds: [], delegated: on } };
      if (q.inputKind !== "multi_choice") return { ...s, [q.id]: { optionIds: [optionId], delegated: false } };
      const ids = on ? [...cur.optionIds.filter((x) => x !== optionId), optionId] : cur.optionIds.filter((x) => x !== optionId);
      return { ...s, [q.id]: { optionIds: q.options.map((o) => o.id).filter((x) => ids.includes(x)), delegated: false } };
    });

  return (
    <form
      className="w-full space-y-5 sm:max-w-[92%]"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !disabled) onAnswer(ready);
      }}
    >
      {questions.map((q, i) => {
        const multi = q.inputKind === "multi_choice";
        const cur = sel[q.id];
        const name = `${base}-${i}`;
        return (
          <fieldset key={q.id} disabled={disabled} className="min-w-0 space-y-3">
            <legend className="mb-3 whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">{q.prompt}</legend>
            <div className="grid gap-2">
              {[...q.options.map((o) => ({ id: o.id as string | null, label: o.label })), { id: null, label: DELEGATE_LABEL }].map((o) => {
                const checked = o.id === null ? !!cur?.delegated : !!cur?.optionIds.includes(o.id);
                return (
                  <label
                    key={o.id ?? "delegate"}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border bg-panel px-3.5 py-3 text-[15px] leading-snug transition-colors has-[:focus-visible]:border-ink/45 ${checked ? "border-ink/45 text-ink" : "border-line text-ink-2 hover:border-ink/25"} ${disabled ? "cursor-default opacity-60" : ""}`}
                  >
                    <input
                      type={multi ? "checkbox" : "radio"}
                      name={name}
                      checked={checked}
                      onChange={(e) => pick(q, o.id, e.target.checked)}
                      className="m-0 h-4 w-4 shrink-0 focus-visible:outline-none"
                    />
                    <span>{o.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      <button
        type="submit"
        disabled={disabled || !ready}
        className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-panel transition-colors hover:bg-accent disabled:opacity-25 disabled:hover:bg-ink"
      >
        Continue
      </button>
    </form>
  );
}
