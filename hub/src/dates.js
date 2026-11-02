// The last day of a testing window: uat_days calendar days, or uat_days weekdays (weekends skipped), after it starts.
export function windowEnd(start, days, type) {
  const date = new Date(start + 'T00:00:00Z');
  if (type !== 'business') { date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
  for (let left = days; left > 0;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() % 6 !== 0) left--;
  }
  return date.toISOString().slice(0, 10);
}
