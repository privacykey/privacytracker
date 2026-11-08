/**
 * Reads how many apps the install holds, from the `{ total }` envelope of
 * `/api/apps?limit=1`.
 *
 * A page with the count badge in its nav and a `RequireAppsGate` mounts both
 * in one commit, so they ask at the same moment. Overlapping callers share
 * one request, so the page sends one read and the badge and the gate cannot
 * be told different things. The slot clears when the request settles, so a
 * retry after a failure always reaches the server.
 */
let inFlight: Promise<number> | null = null;

export function readAppCount(): Promise<number> {
  if (inFlight) {
    return inFlight;
  }
  const read = fetch("/api/apps?limit=1")
    .then((res) =>
      res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))
    )
    .then(({ total }: { total: number }) => {
      if (typeof total !== "number") {
        throw new Error("Invalid apps count");
      }
      return total;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = read;
  return read;
}
