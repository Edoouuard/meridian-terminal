/** A greyed "Building" tag for a feature Meridian shows but doesn't run yet. */
export function BuildingBadge({ title }: { title?: string }) {
  return (
    <span className="badge-building" title={title ?? "Being built: not available yet"}>
      Building
    </span>
  );
}
