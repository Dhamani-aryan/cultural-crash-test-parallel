"use client";

import type { RunState } from "@/lib/crashtest/types";
import type { ClarifyItem } from "./clarify-view";
import type { IntakeState } from "@/lib/intake/types";
import { marketById } from "@/lib/markets";

/**
 * Past chats, kept in this browser only (a per-viewer convenience, never the source of truth).
 * Every read and write is guarded: private windows, blocked storage or a full quota just mean
 * the sidebar starts empty.
 */

export interface SavedChat {
  id: string;
  title: string;
  updatedAt: string;
  intake: IntakeState;
  /** The finished run, when there was one. Dropped first if storage runs out. */
  result: RunState | null;
  /** The clarification exchange before the run, when there was one. */
  clarification?: ClarifyItem[];
}

const KEY = "cct:chats:v1";
const MAX_CHATS = 30;

export function loadChats(): SavedChat[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedChat[]) : [];
    return Array.isArray(list) ? list.filter((c) => c?.id && c.intake) : [];
  } catch {
    return [];
  }
}

function write(list: SavedChat[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Save the list, newest first; if it doesn't fit, drop old runs' results, then old chats. */
export function saveChats(list: SavedChat[]): void {
  let next = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CHATS);
  if (write(next)) return;
  for (let i = next.length - 1; i >= 0; i--) {
    if (!next[i].result) continue;
    next = next.map((c, j) => (j === i ? { ...c, result: null } : c));
    if (write(next)) return;
  }
  while (next.length > 1) {
    next = next.slice(0, -1);
    if (write(next)) return;
  }
}

/** A short title: the brand and city once known, else the start of the first message. */
export function chatTitle(intake: IntakeState): string {
  const b = intake.brief;
  const city = marketById(b.marketId)?.label;
  if (b.brandName && city) return `${b.brandName} · ${city}`;
  if (b.productCategory && city) return `${b.productCategory} · ${city}`;
  const first = intake.messages.find((m) => m.role === "user")?.text ?? "New chat";
  return first.length > 48 ? `${first.slice(0, 46).trimEnd()}…` : first;
}

// ---------- a tiny external store, so React reads the saved list without hydration mismatches ----------

const EMPTY: SavedChat[] = [];
let cache: SavedChat[] | null = null;
const listeners = new Set<() => void>();

export function subscribeChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const getChats = (): SavedChat[] => (cache ??= loadChats());
export const getServerChats = (): SavedChat[] => EMPTY;

export function putChats(list: SavedChat[]): void {
  cache = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  saveChats(cache);
  for (const l of listeners) l();
}
