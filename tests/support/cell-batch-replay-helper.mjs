// A save retried with the same operation ID answers with what the first save
// stored. Only the live answer carries the rows' stamps before the save
// (`previousUpdatedAt`, see previousStamps in server/db.mjs); the stored
// answer keeps its format.
export function replayedResult(result) {
  const { previousUpdatedAt: _, ...stored } = result;
  return stored;
}

// The same for a test's HTTP response wrapper (`{status, data}` or
// `{status, body}`).
export function replayedResponse(response, field = "data") {
  return { ...response, [field]: replayedResult(response[field]) };
}
