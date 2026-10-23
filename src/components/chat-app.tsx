"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MAX_MESSAGE, type Chip } from "@/lib/intake/types";
import { chatTitle, getChats, getServerChats, putChats, subscribeChats, type SavedChat } from "./chat-store";
import { ClarificationCard } from "./clarification";
import { answerFromText } from "./clarify-view";
import { RunResult } from "./run-result";
import { useCrashTest } from "./use-crash-test";
import { useIntake } from "./use-intake";

const PLACEHOLDER = "Tell us what you’re launching, where, and who it needs to resonate with…";

function ProductMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`relative grid shrink-0 grid-cols-2 ${small ? "h-5 w-5 gap-[3px]" : "h-7 w-7 gap-1"}`} aria-hidden>
      <span className="rounded-[2px] bg-ink" />
      <span className="rounded-[2px] bg-accent" />
      <span className="rounded-[2px] bg-ink/25" />
      <span className="rounded-[2px] bg-ink" />
    </span>
  );
}

function Composer({
  onSend,
  busy,
  autoFocus,
  placeholder = PLACEHOLDER,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
    if (ref.current) ref.current.style.height = "";
  };
  return (
    <div className="soft-shadow flex items-end gap-3 rounded-xl border border-line bg-panel px-4 py-3 transition-colors focus-within:border-ink/35">
      <label htmlFor="chat-input" className="sr-only">
        Message
      </label>
      <textarea
        id="chat-input"
        ref={ref}
        autoFocus={autoFocus}
        rows={1}
        value={text}
        maxLength={MAX_MESSAGE}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="max-h-56 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-[15px] leading-relaxed placeholder:text-muted focus-visible:outline-none"
      />
      <button
        type="button"
        onClick={send}
        disabled={busy || !text.trim()}
        aria-label="Send"
        className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink text-panel transition-colors hover:bg-accent disabled:opacity-20 disabled:hover:bg-ink"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function Bubble({ role, children }: { role: "user" | "assistant"; children: React.ReactNode }) {
  return role === "user" ? (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap border-l-2 border-ink/20 bg-panel-2/70 px-4 py-3 text-[15px] leading-relaxed">{children}</div>
    </div>
  ) : (
    <div className="max-w-[92%] whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">{children}</div>
  );
}

/** A compact activity indicator. */
function Thinking({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted" role="status" aria-live="polite">
      <span className="typing" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label && <span>{label}</span>}
      <span className="sr-only">{label ?? "Thinking"}</span>
    </div>
  );
}

function Sidebar({
  chats,
  activeId,
  onOpen,
  onNew,
  onDelete,
  open,
  onClose,
}: {
  chats: SavedChat[];
  activeId: string | null;
  onOpen: (c: SavedChat) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <button type="button" aria-label="Close chats" onClick={onClose} className="fixed inset-0 z-20 bg-black/50 md:hidden" />}
      <aside
        aria-label="Chats"
        className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-line bg-[#eeede8] transition-transform md:static md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-[72px] items-center gap-3 px-5">
          <ProductMark small />
          <div>
            <p className="text-sm font-semibold tracking-[-0.02em]">Cultural Crash-Test</p>
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">Qloo grounded</p>
          </div>
        </div>
        <div className="px-3 pt-2">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-lg border border-ink/15 bg-panel px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:border-ink/30"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            New brief
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {chats.length > 0 && <p className="px-3 pb-2 pt-7 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Recent briefs</p>}
          <ul className="space-y-0.5">
            {chats.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onOpen(c)}
                  aria-current={c.id === activeId ? "page" : undefined}
                  className={`w-full truncate rounded-lg border-l-2 px-3 py-2.5 pr-8 text-left text-sm transition-colors ${c.id === activeId ? "border-accent bg-panel text-ink shadow-sm" : "border-transparent text-ink-2 hover:bg-panel/70"}`}
                  title={c.title}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(c.id)}
                  aria-label={`Delete ${c.title}`}
                  className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1.5 text-muted hover:text-ink group-hover:block group-focus-within:block"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-muted">Briefs stay in this browser.</div>
      </aside>
    </>
  );
}

export function ChatApp() {
  const intake = useIntake();
  const crash = useCrashTest();
  const chats = useSyncExternalStore(subscribeChats, getChats, getServerChats);
  const [pending, setPending] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const s = intake.state;
  const view = crash.view;
  const started = view.phase !== "idle";
  const activeId = s?.intakeId ?? null;

  // Keep the scroll at the newest message, including the one just sent.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [s?.messages.length, pending, intake.busy, view.phase, view.log.length, view.clarify.items.length, view.clarify.sending]);

  // Save the open chat whenever it changes (its finished run too).
  useEffect(() => {
    if (!s || !s.messages.some((m) => m.role === "user")) return;
    const existing = getChats().find((c) => c.id === s.intakeId);
    const result = view.phase === "done" && view.result ? view.result : (existing?.result ?? null);
    const clarification = view.clarify.items.length ? view.clarify.items : existing?.clarification;
    putChats([
      { id: s.intakeId, title: chatTitle(s), updatedAt: new Date().toISOString(), intake: s, result, clarification },
      ...getChats().filter((c) => c.id !== s.intakeId),
    ]);
  }, [s, view.phase, view.result, view.clarify.items]);

  const handle = async (reply: Awaited<ReturnType<typeof intake.send>>) => {
    if (reply?.startRequested) crash.run({ intake: reply.state, depth: "thorough" });
  };
  const send = async (text: string) => {
    // The message shows at once, then the thinking dots, like any chat.
    setPending(text);
    const reply = await intake.send(text);
    setPending(null);
    await handle(reply);
  };
  const chip = async (c: Chip) => {
    setPending(c.label);
    const reply = await intake.chip(c);
    setPending(null);
    await handle(reply);
  };
  const newChat = () => {
    crash.reset();
    intake.reset();
    setSidebar(false);
  };
  const openChat = (c: SavedChat) => {
    intake.setState(c.intake);
    crash.restore(c.result, c.clarification ?? []);
    setSidebar(false);
  };
  const deleteChat = (id: string) => {
    putChats(getChats().filter((c) => c.id !== id));
    if (id === activeId) newChat();
  };
  const awaiting = view.phase === "awaiting";
  const busy = intake.busy || view.phase === "running" || view.clarify.sending;
  // While a question is open, the composer answers it.
  const reply = (text: string) => crash.answer(answerFromText(text), text);
  const lastQuestions = [...view.clarify.items].reverse().find((x) => x.kind === "questions");
  const lastStage = [...view.log].reverse().find((l) => l.kind === "stage");
  const messages = s?.messages ?? [];
  const inConversation = Boolean(s) || pending !== null;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        chats={chats}
        activeId={activeId}
        onOpen={openChat}
        onNew={newChat}
        onDelete={deleteChat}
        open={sidebar}
        onClose={() => setSidebar(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex h-[72px] shrink-0 items-center gap-3 border-b border-line/80 bg-bg px-4 sm:px-7">
          <button type="button" onClick={() => setSidebar(true)} aria-label="Open chats" className="-ml-1 rounded p-1 text-muted hover:text-ink md:hidden">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
              <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <span className="md:hidden"><ProductMark small /></span>
          <span className="text-sm font-semibold md:hidden">Cultural Crash-Test</span>
          <div className="ml-auto hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-muted sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-supported" />
            Evidence system ready
          </div>
        </nav>

        {!inConversation ? (
          <main className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-5 pb-24">
            <div className="mb-9 w-full max-w-2xl">
              <p className="mb-5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">Pre-launch cultural intelligence</p>
              <h1 className="max-w-xl text-4xl font-semibold leading-[1.05] tracking-[-0.045em] text-ink sm:text-5xl">Test the cultural logic before launch.</h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-ink-2">Describe the launch as you would to a strategist. We’ll structure the brief, surface what’s missing, and test the plan against Qloo.</p>
            </div>
            <div className="w-full max-w-2xl">
              <Composer onSend={send} busy={busy} autoFocus />
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                <span>01 · Brief</span><span>02 · Test</span><span>03 · Decision review</span>
              </div>
              {intake.error && <p className="mt-3 text-center text-sm text-nosupport">{intake.error}</p>}
            </div>
          </main>
        ) : (
          <>
            <main className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[880px] space-y-6 px-5 pb-8 pt-10 sm:px-8">
                {messages.map((m, i) => (
                  <div key={m.id} className="space-y-3">
                    <Bubble role={m.role}>{m.text}</Bubble>
                    {i === messages.length - 1 && m.role === "assistant" && s!.chips.length > 0 && !busy && !started && !pending && (
                      <div className="flex flex-wrap gap-2">
                        {s!.chips.map((c, j) => (
                          <button
                            key={j}
                            type="button"
                            onClick={() => chip(c)}
                            className={`rounded-lg border px-3.5 py-2 text-sm transition-colors ${c.action === "confirm" ? "border-accent bg-accent text-white hover:bg-[var(--accent-hover)]" : "border-line bg-panel text-ink-2 hover:border-ink/30"}`}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {pending && <Bubble role="user">{pending}</Bubble>}
                {intake.busy && <Thinking />}
                {view.clarify.items.map((item) =>
                  item.kind === "questions" ? (
                    awaiting && item === lastQuestions && view.clarify.active ? (
                      <ClarificationCard key={item.id} questions={item.questions} disabled={view.clarify.sending} onAnswer={(a) => crash.answer(a.answers, a.receipt)} />
                    ) : (
                      <Bubble key={item.id} role="assistant">
                        {item.questions.map((q) => q.prompt).join("\n")}
                      </Bubble>
                    )
                  ) : (
                    <Bubble key={item.id} role={item.kind}>
                      {item.text}
                    </Bubble>
                  ),
                )}
                {view.clarify.sending && <Thinking />}
                {view.clarify.recovery && (
                  <p className="text-sm text-nosupport" role="alert">
                    {view.clarify.recovery.message}
                    <button
                      type="button"
                      onClick={view.clarify.recovery.action === "restart" ? crash.restart : crash.retry}
                      className="ml-2 text-accent hover:underline"
                    >
                      {view.clarify.recovery.action === "restart" ? "Start again" : "Try again"}
                    </button>
                  </p>
                )}
                {started && view.phase === "running" && (
                  <div className="flex items-center gap-3">
                    <Thinking label={lastStage?.kind === "stage" ? lastStage.message : "Starting…"} />
                    <button type="button" onClick={crash.cancel} className="ml-auto text-xs text-muted hover:text-ink">
                      Stop
                    </button>
                  </div>
                )}
                {view.replay && (
                  <p className="text-xs text-muted">
                    {view.replay}
                    {s && view.phase === "done" && (
                      <button
                        type="button"
                        onClick={() => crash.run({ intake: s, depth: "thorough" }, true)}
                        className="ml-2 text-accent hover:underline"
                      >
                        Run live again
                      </button>
                    )}
                  </p>
                )}
                {view.error && <p className="text-sm text-nosupport">{view.error}</p>}
                {view.result && <RunResult state={view.result} />}
                {intake.error && <p className="text-sm text-nosupport">{intake.error}</p>}
                <div ref={end} />
              </div>
            </main>
            {(!started || (awaiting && view.clarify.recovery?.action !== "restart")) && (
              <div className="shrink-0 bg-gradient-to-t from-bg via-bg to-transparent px-4 pb-6 pt-5">
                <div className="mx-auto w-full max-w-[880px]">
                  {awaiting ? <Composer key="reply" onSend={reply} busy={busy} placeholder="Reply…" autoFocus /> : <Composer key="brief" onSend={send} busy={busy} />}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
