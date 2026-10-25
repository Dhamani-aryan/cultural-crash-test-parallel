export interface ErrorPresentation {
  title: string;
  message: string;
  suggestion: string;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Convert API codes into useful, non-technical recovery guidance. */
export function apiErrorMessage(
  code: unknown,
  status: number,
  detail: unknown,
  area: "intake" | "run",
): string {
  const known = text(code);
  const explanation = text(detail);
  if (status === 429 || known === "rate_limited")
    return "The public demo has reached its live-use limit. Wait a few minutes, then try again; saved completed briefs remain available in this browser.";
  if (known === "unsupported_city")
    return "That city is not in the measured production set yet. Choose New York, London, Tokyo, Mumbai, São Paulo, Madrid, Mexico City, Toronto, Sydney, Paris or Berlin.";
  if (known === "not_configured")
    return "The live research service is temporarily unavailable. Your brief is still saved in this browser; try again after the deployment configuration is restored.";
  if (known === "qloo_error")
    return "Qloo could not complete the cultural evidence check, so no recommendation was finalized. Your brief is still saved; retry the run in a moment.";
  if (known === "llm_error")
    return area === "intake"
      ? "The brief assistant could not finish this turn. Your existing brief is still saved; send the message again in a moment."
      : "The planning model could not complete its bounded task, so no final comparison was produced. Your brief is still saved; retry the run.";
  if (known === "brief_not_confirmed")
    return (
      explanation ?? "Review and confirm the structured brief before starting the cultural test."
    );
  if (status >= 500)
    return "The service could not complete this request. Nothing was submitted as a final recommendation; your brief remains saved in this browser.";
  return explanation ?? known ?? `The request could not be completed (${status}).`;
}

/** Give streamed/network failures a consistent heading and a concrete next step. */
export function presentError(message: string): ErrorPresentation {
  const lower = message.toLowerCase();
  if (lower.includes("rate") && lower.includes("limit"))
    return {
      title: "Public demo limit reached",
      message,
      suggestion: "Wait a few minutes or reopen a saved completed brief from the sidebar.",
    };
  if (lower.includes("city") && (lower.includes("support") || lower.includes("measured")))
    return {
      title: "Choose a supported city",
      message,
      suggestion: "Edit the brief and select one of the measured production markets.",
    };
  if (lower.includes("qloo"))
    return {
      title: "Cultural evidence check did not finish",
      message,
      suggestion: "No verdict was finalized. Keep the brief and retry when Qloo is available.",
    };
  if (lower.includes("model") || lower.includes("llm") || lower.includes("brief assistant"))
    return {
      title: "Planning step did not finish",
      message,
      suggestion: "Your brief is still available. Retry the last step rather than recreating it.",
    };
  if (lower.includes("connection") || lower.includes("network") || lower.includes("fetch"))
    return {
      title: "Connection interrupted",
      message,
      suggestion: "The partial run was not presented as a verdict. Check the connection and retry.",
    };
  if (lower.includes("timeout") || lower.includes("timed out"))
    return {
      title: "The live run took too long",
      message,
      suggestion:
        "Your brief is still saved. Retry once; if it repeats, use a saved completed run.",
    };
  return {
    title: "This step could not be completed",
    message,
    suggestion: "Your work is still saved in this browser. Retry or start a new brief.",
  };
}
