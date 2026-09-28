// Shared calendar/ranking rules. No random choices or external services.
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
export function addDays(date, count) {
  const day = new Date(date + 'T12:00:00Z');
  day.setUTCDate(day.getUTCDate() + count);
  return day.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
export const weekDates = start => Array.from({ length: 7 }, (_, i) => addDays(start, i));

export function recommendMeal(meals, plan, week, date, currentId = null) {
  const used = new Set(week.filter(p => p.plan_date !== date).map(p => Number(p.meal_id)));
  const candidates = meals.filter(m => !used.has(Number(m.id)) && Number(m.id) !== Number(currentId));
  if (!candidates.length) return { meal_id: null, reason: 'No unused alternative. Add more meal ideas or choose one manually.' };
  const weekKeys = new Set(week.map(p => p.plan_date));
  const outsideWeek = plan.filter(p => !weekKeys.has(p.plan_date) && p.meal_id);
  const recent = m => outsideWeek.reduce((gap, p) => Number(p.meal_id) === Number(m.id)
    ? Math.min(gap, Math.abs(daysBetween(p.plan_date, date))) : gap, Infinity);
  // Prefer a two-week gap, then one week. Relax only when there is no candidate.
  const minimumGap = [14, 7, 0].find(gap => candidates.some(m => recent(m) >= gap));
  const tagsUsed = new Map();
  for (const row of week.filter(p => p.plan_date !== date)) {
    const meal = meals.find(m => Number(m.id) === Number(row.meal_id));
    for (const tag of meal?.tags || []) tagsUsed.set(tag, (tagsUsed.get(tag) || 0) + 1);
  }
  const previous = week.find(p => p.plan_date === addDays(date, -1));
  const previousTags = meals.find(m => Number(m.id) === Number(previous?.meal_id))?.tags || [];
  const ranked = candidates.filter(m => recent(m) >= minimumGap).map(m => {
    const gap = recent(m);
    const varietyPenalty = (m.tags || []).reduce((n, tag) => n + (tagsUsed.get(tag) || 0) * 2 + (previousTags.includes(tag) ? 3 : 0), 0);
    // Shrink one-off ratings toward 3; cap votes so popularity doesn't erase variety.
    const count = Number(m.rating_count || 0);
    const rating = (Number(m.average_rating || 0) * count + 6) / (count + 2);
    return { meal: m, gap, score: rating * 3 + Math.min(Number(m.vote_count || 0), 6) * 2 + Math.min(gap, 60) / 10 - varietyPenalty };
  }).sort((a, b) => b.score - a.score || Number(a.meal.id) - Number(b.meal.id));
  const { meal, gap } = ranked[0];
  const reasons = [];
  if (Number(meal.average_rating) >= 4) reasons.push('a family favorite');
  if (Number(meal.vote_count)) reasons.push(`${meal.vote_count} family vote${Number(meal.vote_count) === 1 ? '' : 's'}`);
  if (gap === Infinity) reasons.push('not in nearby plans');
  else if (gap >= 14) reasons.push(`${gap} days from its nearest planned dinner`);
  else reasons.push(`limited options: only ${gap} days from another planned dinner`);
  if ((meal.tags || []).length) reasons.push('tags balanced across the week');
  return { meal_id: Number(meal.id), reason: reasons.join(' · ') };
}

export function proposeWeek(meals, plan, start, today) {
  const week = weekDates(start).map(date => ({ plan_date: date, meal_id: null, note: '', ...plan.find(p => p.plan_date === date) }));
  for (const row of week) {
    if (row.plan_date < today || row.meal_id || row.note) continue;
    Object.assign(row, recommendMeal(meals, plan, week, row.plan_date));
  }
  return week;
}
