import { describe, it, expect } from 'vitest';
import { isBangCommand } from './dispatcher';

describe('isBangCommand', () => {
    it('should detect bang commands', () => {
        expect(isBangCommand('!auth')).toBe(true);
        expect(isBangCommand('!auth work')).toBe(true);
        expect(isBangCommand('!status')).toBe(true);
    });

    it('should reject non-bang messages', () => {
        expect(isBangCommand('hello')).toBe(false);
        expect(isBangCommand('/compact')).toBe(false);
        expect(isBangCommand('')).toBe(false);
    });

    it('should reject lone exclamation mark or space after it', () => {
        expect(isBangCommand('!')).toBe(false);
        expect(isBangCommand('! auth')).toBe(false);
    });

    it('should handle whitespace around the command', () => {
        expect(isBangCommand('  !auth  ')).toBe(true);
        expect(isBangCommand('\t!auth')).toBe(true);
    });

    it('should not match exclamation in the middle of text', () => {
        expect(isBangCommand('hello !auth')).toBe(false);
        expect(isBangCommand('run !status now')).toBe(false);
    });
});
