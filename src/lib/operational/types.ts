export type OperationalStatus = "verified_fit" | "verified_conflict" | "unverified";

export interface OperationalSource {
  title: string;
  url: string;
  snippet: string;
  sourceType: "official" | "reputable_directory" | "other";
  retrievedAt: string;
}

export interface VenueOperationalCheck {
  venue: string;
  city: string;
  status: OperationalStatus;
  /** The concrete fact that changed, or could have changed, the recommendation. */
  finding: string;
  facts: string[];
  limitations: string[];
  sources: OperationalSource[];
}

export interface OperationalResearchClient {
  verifyVenues(input: {
    venues: string[];
    city: string;
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
  version: "operational:v1";
  checkedAt: string;
  checks: VenueOperationalCheck[];
  /** Set only when a deterministic feasibility veto changed the preliminary winner. */
  override?: {
    fromCandidateId: string;
    fromVenue: string;
    toCandidateId: string | null;
    toVenue: string | null;
    reason: string;
  };
}
