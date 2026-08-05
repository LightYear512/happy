import { describe, expect, it } from 'vitest';
import { rejectUnsupportedGeminiRestore } from './restorePolicy';

describe('rejectUnsupportedGeminiRestore', () => {
  it('allows explicit new sessions and rejects every restore identity', () => {
    expect(() => rejectUnsupportedGeminiRestore()).not.toThrow();
    expect(() => rejectUnsupportedGeminiRestore('existing-session'))
      .toThrow('Gemini session restore is unavailable');
  });
});
