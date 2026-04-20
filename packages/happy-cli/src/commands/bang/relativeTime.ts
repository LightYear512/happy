/**
 * Format an absolute timestamp as a Chinese relative-time label for bang-command UI.
 * Pass `justNow: true` to render "刚刚" for sub-minute ages (otherwise "N秒前").
 * Clock skew / future timestamps clamp to 0.
 */
export function formatRelativeTime(at: number | Date, opts?: { justNow?: boolean }): string {
    const timestamp = at instanceof Date ? at.getTime() : at;
    const diffMs = Math.max(0, Date.now() - timestamp);
    const sec = Math.floor(diffMs / 1000);
    const min = Math.floor(diffMs / 60_000);
    const hour = Math.floor(diffMs / 3_600_000);
    const day = Math.floor(diffMs / 86_400_000);

    if (min < 1) return opts?.justNow ? '刚刚' : `${sec}秒前`;
    if (min < 60) return `${min}分钟前`;
    if (hour < 24) return `${hour}小时前`;
    if (day < 30) return `${day}天前`;
    return `${Math.floor(day / 30)}月前`;
}
