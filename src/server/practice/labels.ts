// Human labels for dates, computed on the UTC calendar like every other
// "day" in the app.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utcDayNumber(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );
}

// For something that already happened: "Today", "Yesterday", "3 Nov" or, in
// another year, "3 Nov 2025".
export function dayLabel(date: Date, now: Date): string {
  const days = utcDayNumber(now) - utcDayNumber(date);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const base = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return date.getUTCFullYear() === now.getUTCFullYear() ? base : `${base} ${date.getUTCFullYear()}`;
}

// For the next practice: "Now" once due, then "Today", "Tomorrow", "In 3 days".
export function nextPracticeLabel(date: Date, now: Date): string {
  if (date.getTime() <= now.getTime()) return "Now";
  const days = utcDayNumber(date) - utcDayNumber(now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}
