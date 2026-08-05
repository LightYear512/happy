import { describe, expect, it } from 'vitest';
import { modelMayChangeTitle, sessionTitleAuthority } from './titleAuthority';

describe('session title authority', () => {
    it('external title authority blocks model writes and preserves model default', () => {
        expect(sessionTitleAuthority({})).toBe('model');
        expect(modelMayChangeTitle({})).toBe(true);
        expect(sessionTitleAuthority({ HAPPY_TITLE_AUTHORITY: 'external' })).toBe('external');
        expect(modelMayChangeTitle({ HAPPY_TITLE_AUTHORITY: 'external' })).toBe(false);
        expect(() => sessionTitleAuthority({ HAPPY_TITLE_AUTHORITY: 'hostile' })).toThrow(/Invalid Happy title authority/u);
    });
});
