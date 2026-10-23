/**
 * buildingVenues.ts — venues shown as "Building": wired in the code but not
 * proven end to end, so the planner never proposes them and the UI shows them
 * greyed, without a connect or execute button.
 */
export const BUILDING_VENUES = ["Ondo", "Lighter"] as const;
export const isBuildingVenue = (protocol: string | undefined) => /\b(ondo|lighter)\b/i.test(protocol ?? "");
