/** Format a duration in milliseconds as `m:ss`, or `h:mm:ss` from one hour on. Never negative. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * Shorten `text` to at most `max` characters, the last one being `…` when something was cut.
 * Counts code points, so a surrogate pair (emoji, rare CJK) is never split.
 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (!(max >= 1)) return '';
  return `${chars.slice(0, max - 1).join('')}…`;
}
