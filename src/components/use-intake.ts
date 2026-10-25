"use client";

import { useCallback, useState } from "react";
import type {
  Chip,
  IntakeBrief,
  IntakeReply,
  IntakeRequest,
  IntakeState,
} from "@/lib/intake/types";
import { apiErrorMessage } from "./error-copy";

/** The intake conversation, held in the browser; the server re-validates it on every turn. */
export function useIntake() {
  const [state, setState] = useState<IntakeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (req: Omit<IntakeRequest, "state">): Promise<IntakeReply | null> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/intake", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...req,
            state: req.action === "reset" ? undefined : (state ?? undefined),
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const detail = Array.isArray(body?.detail) ? body.detail.join("; ") : body?.detail;
          throw new Error(apiErrorMessage(body?.error, res.status, detail, "intake"));
        }
        setState(body.state);
        return body as IntakeReply;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [state],
  );

  const send = useCallback(
    (message: string, marketId?: string) => call({ action: "message", message, marketId }),
    [call],
  );
  const edit = useCallback(
    (patch: Partial<IntakeBrief>) => call({ action: "update_brief", patch }),
    [call],
  );
  const chip = useCallback(
    (c: Chip, marketId?: string) =>
      c.action
        ? call({
            action: c.action,
            hypothesisId: c.hypothesisId,
            patch: c.patch as Partial<IntakeBrief> | undefined,
          })
        : call({ action: "message", message: c.send ?? c.label, marketId }),
    [call],
  );
  const confirm = useCallback(() => call({ action: "confirm" }), [call]);
  const reset = useCallback(() => {
    setState(null);
    setError(null);
  }, []);

  return { state, setState, busy, error, send, edit, chip, confirm, reset };
}
