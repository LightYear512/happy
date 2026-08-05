import { describe, expect, it } from 'vitest';

import { localCommandUserText, modelFacingUserText, type UserMessage } from './types';

describe('modelFacingUserText', () => {
  it('keeps ordinary user messages unchanged', () => {
    const message: UserMessage = { role: 'user', content: { type: 'text', text: 'hello' } };
    expect(modelFacingUserText(message)).toBe('hello');
  });

  it('uses the encrypted model text for a compact message', () => {
    const message: UserMessage = {
      role: 'user',
      content: { type: 'text', text: 'compact summary' },
      meta: { modelText: 'complete body', displayText: 'compact summary', presentation: 'compact' },
    };
    expect(modelFacingUserText(message)).toBe('complete body');
  });

  it('keeps a local command separate from XC model context', () => {
    const message: UserMessage = {
      role: 'user',
      content: { type: 'text', text: '@' },
      meta: { modelText: '[XC required context]\n\n@', displayText: '@', presentation: 'compact' },
    };
    expect(localCommandUserText(message)).toBe('@');
    expect(modelFacingUserText(message)).toBe('[XC required context]\n\n@');
  });

  it('rejects compact messages without complete model text', () => {
    const message: UserMessage = {
      role: 'user',
      content: { type: 'text', text: 'compact summary' },
      meta: { displayText: 'compact summary', presentation: 'compact' },
    };
    expect(() => modelFacingUserText(message)).toThrow(/missing modelText/);
  });
});
