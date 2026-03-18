/**
 * Shared formatting utilities for bang command output.
 * Designed for mobile chat bubble rendering.
 */

/**
 * Center all lines within the block based on the longest line.
 */
export function centerText(lines: string[]): string {
    const maxLen = Math.max(...lines.map(l => l.length));
    return lines.map(line => {
        if (line.length === 0) return '';
        const pad = Math.floor((maxLen - line.length) / 2);
        return ' '.repeat(pad) + line;
    }).join('\n');
}
