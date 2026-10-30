export type OperationalStatus = "verified_fit" | "verified_conflict" | "unverified";

/** The only kinds of conflict that can veto a venue. The first two mean Qloo's record of the place is wrong or out of date. */
export type OperationalConflictKind = "wrong_establishment" | "closed" | "format_unsupported" | "capacity";

export interface OperationalSource {
  title: string;
  url: string;
  snippet: string;
  sourceType: "official" | "reputable_directory" | "other";
  retrievedAt: string;
}

export interface VenueFit {
  kind: "suits" | "unsuitable" | "unclear";
  area: "inside" | "outside" | "unclear" | "not_named";
  access: "open" | "restricted" | "unclear";
  note: string;
}

export interface VenueOperationalCheck {
  venue: string;
  city: string;
  status: OperationalStatus;
  /** The concrete fact that changed, or could have changed, the recommendation. */
  finding: string;
  /** For a verified conflict: which of the permitted kinds it is (absent in older recordings). */
  conflictKind?: OperationalConflictKind;
  /** Plain fit facts read from cited excerpts (absent without a citation, and in older recordings). */
  fit?: VenueFit;
  facts: string[];
  limitations: string[];
  sources: OperationalSource[];
}

export interface OperationalResearchClient {
  verifyVenues(input: {
    venues: string[];
    city: string;
    /** The area the brief names, so the reading can say whether each venue is in it. */
    area?: string;
    brief: {
      productCategory: string;
      launchGoal: string;
      audienceDescription: string;
      sourceText?: string;
    };
    signal?: AbortSignal;
  }): Promise<{ checks: VenueOperationalCheck[]; modelCalls: number }>;
}

export interface OperationalAudit {
  version: "operational:v1" | "operational:v2";
  checkedAt: string;
  checks: VenueOperationalCheck[];
  /** Set only when a deterministic feasibility veto changed the preliminary winner. */
  override?: {
    fromCandidateId: string;
    fromVenue: string;
    toCandidateId: string | null;
    toVenue: string | null;
    reason: string;
    /** Who put the vetoed venue in the plan. */
    fromSource?: "user" | "llm" | "agent" | "search";
    /** What Qloo files the vetoed venue under, e.g. "bar". */
    fromQlooCategory?: string | null;
    kind?: OperationalConflictKind;
    /** The official page that showed the conflict. */
    sourceUrl?: string;
  };
  /** operational:v2: the recommendation moved to another finalist's venue on cited fit facts. */
  preference?: {
    fromCandidateId: string;
    fromVenue: string;
    fromSource?: "user" | "llm" | "agent" | "search";
    toCandidateId: string;
    toVenue: string;
    toSource?: "user" | "llm" | "agent" | "search";
    /** Plain concerns, e.g. "outside the area the brief names". */
    concerns: string[];
    note: string;
    sourceUrl?: string;
  };
}
