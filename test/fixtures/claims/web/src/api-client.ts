// Generated from api/openapi.yaml. Do not edit by hand.
export async function listNotes(notebookId: string): Promise<unknown> {
  const response = await fetch(`/notebooks/${notebookId}/notes`);
  return response.json();
}
