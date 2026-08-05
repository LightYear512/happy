export function rejectUnsupportedGeminiRestore(restoreSessionId?: string): void {
  if (restoreSessionId) {
    throw new Error('Gemini session restore is unavailable. Create a new session explicitly.');
  }
}
