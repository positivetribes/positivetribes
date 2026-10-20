import { addDays, daysBetween, weekDates, proposeWeek, recommendMeal } from './planner.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const themeMedia = matchMedia('(prefers-color-scheme: dark)');
const THEMES = ['system', 'light', 'dark'];
let savedTheme = localStorage.getItem('familyMealsTheme');
if (!THEMES.includes(savedTheme)) savedTheme = 'system';
function applyTheme(choice = savedTheme) {
  const dark = choice === 'dark' || (choice === 'system' && themeMedia.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#18241e' : '#f7f4ed';
}
themeMedia.addEventListener('change', () => applyTheme($('#memberDialog').open ? $('#profileForm [name=theme]:checked')?.value : savedTheme));
applyTheme();
let pin = localStorage.getItem('familyMealsPin') || '';
let member = localStorage.getItem('familyMealsMember') || '';
let data = { meals: [], ratings: [], votes: [], plan: [], members: [], unclaimed: [], absences: [] };
let familyEdit = false;
let weekOffset = 0, selectedRating = 0, activeMeal = null, activeDate = null;
let draft = null, draftRevision = null, tagFilter = '', groceryRequest = 0;
let storeFilter = '', groceryState = null, storeTarget = null;
const NO_STORE = '__none__';
// Lists tab: the weekly Grocery List plus any lists the family creates. Remember the last one opened on this device.
const GROCERY = 'grocery';
const PEOPLE = '<svg class="shared-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.7 3.2 2.5 3.5 5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const PENCIL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Custom lists belong to the profile using this phone; remember the last list per person.
const listKey = () => 'familyMealsList:' + member.toLowerCase();
const savedList = () => { try { return localStorage.getItem(listKey()) || GROCERY; } catch { return GROCERY; } };
let currentList = savedList(), listsOwner = member, needsName = false;
let lists = [], customState = null, customFilter = '', customRequest = 0, listsRequest = 0, knownStores = [], editingList = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const displayDate = value => new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function monday(offset = weekOffset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() || 7) + 1 + offset * 7);
  return iso(date);
}
const initials = name => name ? name.trim().split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase() : '?';
let photo = localStorage.getItem('familyMealsPhoto') || '';
let pendingPhoto = photo;
// Show a photo when there is one, otherwise the person's initials.
function paintAvatar(el, name, src) {
  el.replaceChildren();
  if (src) { const img = new Image(); img.src = src; img.alt = ''; el.append(img); }
  else el.textContent = initials(name);
  el.classList.toggle('has-photo', !!src);
}
// Center-crop to a square and shrink to 256px so it stays small enough to keep on the device.
async function squarePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight), size = Math.min(256, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 5000);
}
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-family-pin': pin, 'x-family-member': encodeURIComponent(member) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) { $('#locked').hidden = false; $('#app').hidden = true; }
    throw Object.assign(new Error(result.error || 'Something went wrong. Please try again.'), { status: response.status });
  }
  return result;
}
const send = (path, method, body) => api(path, { method, body: JSON.stringify(body) });
async function action(button, work) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await work(); } catch (error) { toast(error.message); }
  finally { if (button) button.disabled = false; }
}
async function refresh() {
  data = await api('/summary');
  render();
}
async function load() {
  try {
    await refresh();
    $('#locked').hidden = true;
    $('#app').hidden = false;
    if (!$('#memberDialog').open) {
      if (!member) openProfile();
      else if (!data.members.length) { await registerSelf(); render(); }             // a brand-new family: the first name starts the list
      else if (!inFamily(member)) { if (!pickerDismissed()) openProfile(); }        // an older name: ask who they are
      else if (data.unclaimed.some(m => sameName(m, member))) { await registerSelf(); }  // already known: quietly mark it as taken
    }
  } catch (error) { $('#setupMessage').textContent = error.message; }
}
function render() {
  paintAvatar($('#memberButton'), member, photo);
  renderWeek(); renderMeals();
  if ($('#groceries').classList.contains('active')) loadLists();
  if ($('#chores').classList.contains('active')) loadChores();
}
function switchTab(id) {
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === id));
  $$('.panel').forEach(panel => panel.classList.toggle('active', panel.id === id));
  if (id === 'groceries') loadLists();
  if (id === 'chores') loadChores();
}
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isOut = (date, name) => data.absences.some(a => a.plan_date === date && sameName(a.member, name));
// Show "All home" or just who is out, so the list stays short. Needs at least two people to mean anything.
function whoIsOut(date) { return data.members.filter(name => isOut(date, name)); }
function homeLine(date) {
  if (data.members.length < 2) return '';
  const out = whoIsOut(date).map(esc);
  const names = out.length > 1 ? `${out.slice(0, -1).join(', ')} &amp; ${out[out.length - 1]}` : out[0];
  const text = !out.length ? 'All home' : out.length === data.members.length ? 'Everyone out' : `${names}&nbsp;out`;
  return `<div class="home${out.length ? ' some' : ''}">${text}</div>`;
}
function renderTogether(start) {
  const strip = $('#togetherStrip');
  strip.hidden = data.members.length < 2;
  if (strip.hidden) return;
  const nights = weekDates(start).filter(date => !whoIsOut(date).length).length;
  strip.innerHTML = `<strong>${nights} of 7 nights</strong> everyone's home`;
}
function renderWeek() {
  const start = monday(), source = draft || data.plan;
  const label = `${displayDate(start)} – ${displayDate(addDays(start, 6))}`;
  $('#weekLabel').textContent = label;
  renderTogether(start);
  $('#groceryWeekLabel').textContent = label;
  $('#previewBanner').hidden = !draft;
  $('#planMyWeek').hidden = !!draft;
  $('#planMyWeek').disabled = addDays(start, 6) < today() || !data.meals.length;
  $('#weekTitle').textContent = draft ? 'Your week, proposed' : weekOffset === 0 ? 'This Week' : 'Dinner Plan';
  $$('[data-week-home]').forEach(button => {
    const away = weekOffset !== 0, weeks = Math.abs(weekOffset);
    button.classList.toggle('away', away);
    button.setAttribute('aria-disabled', String(!away));
    button.setAttribute('aria-label', away ? `Back to this week (${weeks} week${weeks > 1 ? 's' : ''} ${weekOffset > 0 ? 'ahead' : 'back'})` : 'Showing this week');
    button.title = away ? 'Back to this week' : 'You are on this week';
  });
  $('#weekList').innerHTML = weekDates(start).map(date => {
    const row = source.find(p => p.plan_date === date);
    const meal = data.meals.find(m => +m.id === +row?.meal_id);
    return `<div class="day-row${date === today() ? ' today' : ''}"><button class="day" data-date="${date}"${date === today() ? ' aria-current="date"' : ''} aria-label="Choose dinner for ${esc(displayDate(date))}${date === today() ? ' (today)' : ''}"><div><div class="dayname">${new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</div><div class="date">${new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div></div><div><div class="meal-title">${esc(meal?.name || row?.note || 'Pick a meal')}</div><div class="meal-sub">${esc(row?.reason || (meal && row?.note) || (draft ? 'Choose or swap before accepting' : 'Tap to plan dinner'))}</div>${homeLine(date)}</div><span>›</span></button>${safeRecipe(meal?.recipe_url) ? `<a class="swap ghost recipe-go" href="${esc(meal.recipe_url)}" target="_blank" rel="noopener noreferrer" aria-label="Open the recipe for ${esc(meal.name)}">Recipe ↗</a>` : ''}${date >= today() ? `<button class="swap ghost" data-date="${date}" aria-label="Suggest another dinner for ${esc(displayDate(date))}">Swap</button>` : ''}</div>`;
  }).join('');
  $$('.day').forEach(button => button.onclick = () => openPlan(button.dataset.date));
  $$('.swap').forEach(button => button.onclick = () => { openPlan(button.dataset.date); suggestSwap(); });
}
function historyFor(id) { return data.plan.filter(p => +p.meal_id === +id && p.plan_date < today()).sort((a, b) => b.plan_date.localeCompare(a.plan_date)); }
function lastMade(id) {
  const history = historyFor(id);
  if (!history.length) return 'Not made yet · no past plans';
  const gap = daysBetween(history[0].plan_date, today());
  return `Last made: ${gap === 1 ? 'yesterday' : gap < 14 ? `${gap} days ago` : `${Math.floor(gap / 7)} weeks ago`} · ${displayDate(history[0].plan_date)}`;
}
function safeRecipe(url) { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } }
function renderMeals() {
  const tags = [...new Set(data.meals.flatMap(meal => meal.tags || []))].sort();
  if (!tags.includes(tagFilter)) tagFilter = '';
  $('#tagFilter').innerHTML = '<option value="">All tags</option>' + tags.map(tag => `<option value="${esc(tag)}" ${tag === tagFilter ? 'selected' : ''}>${esc(tag)}</option>`).join('');
  const query = $('#mealSearch').value.trim().toLowerCase();
  const meals = data.meals.filter(m => (!tagFilter || m.tags.includes(tagFilter)) && `${m.name} ${m.notes} ${m.tags.join(' ')}`.toLowerCase().includes(query));
  $('#ideasList').innerHTML = meals.map(mealCard).join('') || '<div class="card auth-card">No meals match. Try another tag or suggest a meal.</div>';
  $('#favoritesList').innerHTML = data.meals.filter(m => Number(m.average_rating) >= 4).map(mealCard).join('') || '<div class="card auth-card">Your 4+ star meals will appear here.</div>';
  $$('.vote').forEach(button => button.onclick = () => action(button, async () => {
    if (!member) return openProfile();
    await send('/vote', 'POST', { meal_id: +button.dataset.id, member }); await refresh();
  }));
  $$('.edit-meal').forEach(button => button.onclick = () => openEditMeal(button.dataset.id));
  $$('.rate').forEach(button => button.onclick = () => openRate(button.dataset.id));
}
function mealCard(meal) {
  const mine = data.ratings.find(r => +r.meal_id === +meal.id && r.member === member);
  const voted = data.votes.some(v => +v.meal_id === +meal.id && v.member === member);
  const history = historyFor(meal.id);
  return `<article class="meal-card"><div class="meal-row"><div><h3>${esc(meal.name)}</h3><div class="hint">${esc(meal.notes || (meal.suggested_by ? `Suggested by ${meal.suggested_by}` : 'Family meal'))}</div></div><div class="score">${meal.average_rating ? `★ ${Number(meal.average_rating).toFixed(1)}` : 'New'}</div></div><div class="tags">${meal.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div><p class="last-made">${lastMade(meal.id)}</p>${history.length ? `<details class="history"><summary>${history.length} past dinner${history.length === 1 ? '' : 's'}</summary><p class="hint">Based on past plans, not confirmed cooking.</p><ul>${history.map(p => `<li>${displayDate(p.plan_date)}${p.note ? ` · ${esc(p.note)}` : ''}</li>`).join('')}</ul></details>` : ''}<div class="chips"><button class="chip vote ${voted ? 'voted' : ''}" data-id="${meal.id}">♥ ${meal.vote_count || 0} want this</button><button class="chip edit-meal" data-id="${meal.id}">✎ Edit</button><button class="chip rate" data-id="${meal.id}">${mine ? `★ Your ${mine.rating}/5` : '☆ Rate it'}</button>${safeRecipe(meal.recipe_url) ? `<a class="chip" href="${esc(meal.recipe_url)}" target="_blank" rel="noopener noreferrer">Recipe ↗</a>` : ''}</div></article>`;
}
function openEditMeal(id) {
  activeMeal = +id;
  const meal = data.meals.find(m => +m.id === activeMeal);
  if (!meal) return;
  $('#editMealName').value = meal.name;
  $('#editRecipeUrl').value = meal.recipe_url || '';
  $('#editMealNotes').value = meal.notes || '';
  $('#editMealTags').value = meal.tags.join(', ');
  $('#editIngredients').value = meal.ingredients.join('\n');
  $('#editMealDialog').showModal();
}
function mealPayload(edit = false) {
  return { name: $(edit ? '#editMealName' : '#mealName').value, recipe_url: $(edit ? '#editRecipeUrl' : '#recipeUrl').value,
    notes: $(edit ? '#editMealNotes' : '#mealNotes').value,
    tags: $(edit ? '#editMealTags' : '#mealTags').value.split(',').map(s => s.trim()).filter(Boolean),
    ingredients: $(edit ? '#editIngredients' : '#ingredients').value.split('\n').map(s => s.trim()).filter(Boolean) };
}
function openRate(id) {
  if (!member) return openProfile();
  activeMeal = +id;
  const mine = data.ratings.find(r => +r.meal_id === activeMeal && r.member === member);
  selectedRating = Number(mine?.rating || 0);
  $('#ratingComment').value = mine?.comment || '';
  $('#rateTitle').textContent = 'Rate ' + data.meals.find(m => +m.id === activeMeal)?.name;
  renderStars(); $('#rateDialog').showModal();
}
function renderStars() {
  $('#stars').innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" class="star ${n <= selectedRating ? 'on' : ''}" data-n="${n}" aria-label="${n} stars" aria-pressed="${n === selectedRating}">★</button>`).join('');
  $$('.star').forEach(button => button.onclick = () => { selectedRating = +button.dataset.n; renderStars(); });
}
function openPlan(date) {
  activeDate = date;
  const row = (draft || data.plan).find(p => p.plan_date === date);
  $('#planTitle').textContent = `Dinner · ${displayDate(date)}`;
  $('#planMeal').innerHTML = '<option value="">No meal selected</option>' + data.meals.map(meal => `<option value="${meal.id}" ${+row?.meal_id === +meal.id ? 'selected' : ''}>${esc(meal.name)}</option>`).join('');
  $('#planNote').value = row?.note || '';
  $('#swapReason').textContent = '';
  $('#savePlan').textContent = draft ? 'Update preview' : 'Save dinner';
  $('#suggestSwap').hidden = date < today();
  familyEdit = false; $('#addPerson').hidden = true;
  renderWho();
  $('#planDialog').showModal();
}
function renderWho() {
  const people = [...data.members].sort((a, b) => sameName(a, member) ? -1 : sameName(b, member) ? 1 : 0);
  $('#peopleList').innerHTML = people.map(name => {
    const out = isOut(activeDate, name), me = sameName(name, member);
    const label = familyEdit ? `Remove ${name} from the family list` : `${name}${me ? ' (you)' : ''}: ${out ? 'out' : 'home'}. Tap to mark ${out ? 'home' : 'out'}`;
    return `<button type="button" class="person${out && !familyEdit ? ' out' : ''}${me ? ' me' : ''}${familyEdit ? ' editing' : ''}" data-name="${esc(name)}" aria-label="${esc(label)}"><b>${esc(initials(name))}${familyEdit ? '<i>×</i>' : ''}</b><span class="pname">${esc(name)}</span><small>${familyEdit ? 'Remove' : `${me ? 'You · ' : ''}${out ? 'Out' : 'Home'}`}</small></button>`;
  }).join('') + (familyEdit ? '' : '<button type="button" class="person add" id="addPersonButton" aria-label="Add a family member"><b>+</b><span class="pname">Add</span><small>&nbsp;</small></button>');
  $('#whoHint').textContent = data.members.length < 2 ? 'Add your family to see who can make it to dinner.' : familyEdit ? 'Tap a person to remove them.' : 'Tap to mark someone out.';
  $('#editFamily').hidden = !data.members.length;
  $('#editFamily').textContent = familyEdit ? 'Done' : 'Edit family';
  $$('#peopleList .person[data-name]').forEach(button => button.onclick = () => action(button, async () => familyEdit ? removePerson(button.dataset.name) : toggleAbsence(button.dataset.name)));
  const add = $('#addPersonButton');
  if (add) add.onclick = () => { $('#addPerson').hidden = false; $('#newPerson').focus(); };
}
async function toggleAbsence(name) {
  const date = activeDate, out = !isOut(date, name);
  await send('/absence', 'POST', { plan_date: date, member: name, out });
  data.absences = data.absences.filter(a => !(a.plan_date === date && sameName(a.member, name)));
  if (out) data.absences.push({ plan_date: date, member: name });
  renderWho(); renderWeek();
}
// Tell the family list who this phone is. Claiming hides the name from other people's first-time picker.
async function registerSelf(previous) {
  if (!member) return;
  try {
    const result = await send('/members', 'POST', { name: member, claim: true, ...(previous && !sameName(previous, member) ? { release: previous } : {}) });
    if (!data.members.some(m => sameName(m, result.name))) data.members.push(result.name);
    data.unclaimed = data.unclaimed.filter(m => !sameName(m, result.name));
    if (previous && !sameName(previous, result.name) && data.members.some(m => sameName(m, previous)) && !data.unclaimed.some(m => sameName(m, previous))) data.unclaimed.push(previous);
  } catch { /* the family list is a convenience; never block the app on it */ }
}
async function removePerson(name) {
  if (!confirm(`Remove ${name} from the family list?\n\nTheir in/out marks are cleared. Ratings and votes stay.`)) return;
  await send('/members', 'DELETE', { name });
  data.members = data.members.filter(m => !sameName(m, name));
  data.absences = data.absences.filter(a => !sameName(a.member, name));
  data.unclaimed = data.unclaimed.filter(m => !sameName(m, name));
  if (!data.members.length) familyEdit = false;
  renderWho(); renderWeek();
}
function suggestSwap() {
  const week = weekDates(monday()).map(date => ({ plan_date: date, ...(draft || data.plan).find(p => p.plan_date === date) }));
  const result = recommendMeal(data.meals, data.plan, week, activeDate, +$('#planMeal').value || null);
  if (result.meal_id) $('#planMeal').value = result.meal_id;
  $('#swapReason').textContent = result.reason;
}
async function navigateWeek(offset) {
  if (draft && !confirm('Discard this unaccepted preview?')) return;
  draft = null; weekOffset += offset; renderWeek();
  if ($('#groceries').classList.contains('active') && currentList === GROCERY) await loadGroceries();
}
async function loadGroceries() {
  const requestId = ++groceryRequest, start = monday();
  $('#groceryStatus').textContent = 'Loading your list…';
  $('#groceryList').innerHTML = '';
  $('#missingIngredients').innerHTML = '';
  try {
    const result = await api('/groceries?week=' + start);
    if (requestId !== groceryRequest) return;
    groceryState = { result, start };
    renderGroceries();
  } catch (error) { if (requestId === groceryRequest) $('#groceryStatus').textContent = error.message; }
}
function renderGroceries() {
  if (!groceryState) return;
  const { result, start } = groceryState;
  const items = [...result.generated.map(item => ({ ...item, kind: 'generated' })), ...result.manual.map(item => ({ ...item, kind: 'manual' }))];
  const weekStores = [...new Set(items.map(item => item.store).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const unassigned = items.filter(item => !item.store).length;
  // Only offer store filtering once at least one item has a store; drop a filter that no longer applies.
  if (!weekStores.length || (storeFilter === NO_STORE ? !unassigned : storeFilter && !weekStores.includes(storeFilter))) storeFilter = '';
  $('#storeFilterBar').hidden = !weekStores.length;
  $('#storeFilter').innerHTML = `<option value="">All stores (${items.length})</option>` +
    weekStores.map(store => `<option value="${esc(store)}" ${store === storeFilter ? 'selected' : ''}>${esc(store)} (${items.filter(item => item.store === store).length})</option>`).join('') +
    (unassigned ? `<option value="${NO_STORE}" ${storeFilter === NO_STORE ? 'selected' : ''}>No store yet (${unassigned})</option>` : '');
  knownStores = result.stores;
  $('#storeOptions').innerHTML = result.stores.map(store => `<option value="${esc(store)}">`).join('');
  const shown = items.map((item, i) => ({ item, i })).filter(({ item }) => !storeFilter || (storeFilter === NO_STORE ? !item.store : item.store === storeFilter));
  $('#groceryStatus').textContent = `${shown.filter(({ item }) => item.checked).length} of ${shown.length} checked${storeFilter ? (storeFilter === NO_STORE ? ' · no store yet' : ' · ' + storeFilter) : ''} · ${result.planned_count} planned dinners${draft ? ' · Preview is not saved yet' : ''}`;
  $('#missingIngredients').innerHTML = result.missing.length ? `<p class="hint">Add ingredients to complete the list:</p><div class="chips">${result.missing.map(meal => `<button class="chip missing-meal" data-id="${meal.id}">${esc(meal.name)} +</button>`).join('')}</div>` : '';
  $$('.missing-meal').forEach(button => button.onclick = () => openEditMeal(button.dataset.id));
  $('#groceryList').innerHTML = shown.map(({ item, i }) => `<div class="grocery-item ${item.checked ? 'checked' : ''}"><label><input type="checkbox" data-item="${i}" ${item.checked ? 'checked' : ''}><span><strong>${esc(item.label)}${item.count > 1 ? ` × ${item.count} meals` : ''}</strong><small>${item.kind === 'manual' ? 'Added by your family' : esc(item.meals.join(' · ')) + (item.edited ? ` · edited from “${esc(item.original_label)}”` : '')}</small></span></label><button class="chip store-chip ${item.store ? 'set' : ''}" data-item="${i}" aria-label="${item.store ? `Store for ${esc(item.label)}: ${esc(item.store)}. Change store` : `Choose a store for ${esc(item.label)}`}">${item.store ? esc(item.store) : '+ Store'}</button><button class="ghost edit-item" data-item="${i}" aria-label="Edit ${esc(item.label)}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`).join('') || '<div class="card auth-card">Plan dinners and add their ingredients, or add an item below.</div>';
  $$('#groceryList input').forEach(input => input.onchange = () => action(input, async () => {
    const item = items[+input.dataset.item];
    try { await send('/groceries', 'PATCH', { week_start: start, kind: item.kind, id: item.id, key: item.key, checked: input.checked }); }
    catch (error) { input.checked = !input.checked; throw error; }
    await loadGroceries();
  }));
  $$('.edit-item').forEach(button => button.onclick = () => openItem(items[+button.dataset.item]));
  $$('.store-chip').forEach(button => button.onclick = () => openStore(items[+button.dataset.item]));
}
let itemTarget = null;
function openItem(item) {
  itemTarget = item;
  $('#itemInput').value = item.label;
  $('#itemNote').textContent = item.kind === 'generated' ? `From ${item.meals.join(', ')}. This changes this week's list only — the recipe stays the same.` : '';
  $('#itemNote').hidden = item.kind !== 'generated';
  $('#deleteItem').hidden = item.kind === 'generated';
  $('#resetItem').hidden = !item.edited;
  $('#itemDialog').showModal();
  $('#itemInput').focus();
}
function saveItemLabel(submitter, label) {
  return action(submitter, async () => {
    const item = itemTarget;
    if (item.kind === 'list') {
      await send('/lists/items', 'PATCH', { list_id: item.list_id, id: item.id, label });
      $('#itemDialog').close(); return loadCustom();
    }
    await send('/groceries/label', 'POST', { week_start: groceryState.start, kind: item.kind, id: item.id, key: item.key, label });
    $('#itemDialog').close(); await loadGroceries();
  });
}
$('#itemForm').onsubmit = event => { event.preventDefault(); saveItemLabel(event.submitter, $('#itemInput').value); };
$('#resetItem').onclick = event => saveItemLabel(event.currentTarget, '');
$('#deleteItem').onclick = event => {
  if (!confirm(`Remove “${itemTarget.label}” from the list?`)) return;
  action(event.currentTarget, async () => {
    if (itemTarget.kind === 'list') {
      await send('/lists/items', 'DELETE', { list_id: itemTarget.list_id, id: itemTarget.id });
      $('#itemDialog').close(); return loadCustom();
    }
    await send('/groceries', 'DELETE', { week_start: groceryState.start, kind: 'manual', id: itemTarget.id });
    $('#itemDialog').close(); await loadGroceries();
  });
};
function openStore(item) {
  storeTarget = item;
  $('#storeTitle').textContent = `Where to buy ${item.label}`;
  $('#storeInput').value = item.store || '';
  $('#storeChips').innerHTML = knownStores.map(store => `<button type="button" class="chip pick-store ${store === item.store ? 'voted' : ''}" data-store="${esc(store)}">${esc(store)}</button>`).join('');
  $$('.pick-store').forEach(button => button.onclick = () => { $('#storeInput').value = button.dataset.store; $('#storeForm').requestSubmit(); });
  $('#clearStore').hidden = !item.store;
  $('#storeDialog').showModal();
}
$('#pinForm').onsubmit = event => {
  event.preventDefault(); pin = $('#pin').value.trim(); localStorage.setItem('familyMealsPin', pin); action(event.submitter, load);
};
const inFamily = name => data.members.some(m => sameName(m, name));
const pickerDismissed = () => { try { return sessionStorage.getItem('familyMealsPickerDismissed') === '1'; } catch { return false; } };
let profileMode = 'profile', pickerAll = false, picked = false;
// 'pick' shows the family's names to tap; 'new' asks for a typed name; 'profile' is the normal settings screen.
function setProfileMode(mode) {
  profileMode = mode;
  const pick = mode === 'pick', typing = mode === 'new';
  $('#pickPanel').hidden = !pick;
  $('#nameField').hidden = pick;
  $('#themeField').hidden = pick || typing;
  $('.photo-picker').hidden = pick || typing;
  $('#saveMember').hidden = pick;
  $('#cancelProfile').textContent = pick ? 'Not now' : 'Cancel';
  $('#profileForm').classList.toggle('picking', pick || typing);
}
function renderPicker() {
  const showAll = pickerAll || !data.unclaimed.length;
  const names = showAll ? data.members : data.unclaimed;
  const taken = name => !data.unclaimed.some(m => sameName(m, name));
  $('#pickList').innerHTML = names.map(name => `<button type="button" class="person" data-name="${esc(name)}" aria-label="I'm ${esc(name)}"><b>${esc(initials(name))}</b><span class="pname">${esc(name)}</span><small>${showAll && taken(name) ? 'Other phone' : '&nbsp;'}</small></button>`).join('');
  $$('#pickList .person').forEach(button => button.onclick = () => action(button, () => chooseName(button.dataset.name)));
  $('#pickShowAll').hidden = showAll;
  $('#profileTitle').textContent = 'Who are you?';
  $('#profileHint').textContent = member ? `This phone is saved as “${member}”. Tap who you are in the family.`
    : !data.unclaimed.length ? 'Everyone’s name is taken. If this is a new phone, tap yours.'
    : showAll ? 'Everyone in the family. Tap yours if this is a new phone.' : 'Tap your name.';
}
async function chooseName(name) {
  const previous = member;
  member = name;
  await registerSelf(previous);
  member = data.members.find(m => sameName(m, name)) || name;
  localStorage.setItem('familyMealsMember', member);
  picked = true;
  $('#memberDialog').close(); render(); toast(`Welcome, ${member}`);
}
function openProfile() {
  picked = false; pickerAll = false;
  $('#memberName').value = member;
  pendingPhoto = photo;
  paintProfilePhoto();
  $$('#profileForm [name=theme]').forEach(radio => radio.checked = radio.value === savedTheme);
  if (data.members.length && (!member || !inFamily(member))) { setProfileMode('pick'); renderPicker(); }
  else {
    setProfileMode('profile');
    $('#profileTitle').textContent = member ? 'Profile' : 'Who are you?';
    $('#profileHint').textContent = member ? 'Settings for you on this device.' : 'Add your name so the family knows who rated what.';
  }
  $('#memberDialog').showModal();
  // Only jump into the name field (and raise the keyboard) when a name still has to be typed.
  if (profileMode === 'pick') $('#profileTitle').focus(); else if (member) $('#profileTitle').focus(); else $('#memberName').focus();
}
$('#memberButton').onclick = openProfile;
function paintProfilePhoto() {
  paintAvatar($('#profileAvatar'), $('#memberName').value, pendingPhoto);
  $('#photoAction').textContent = pendingPhoto ? 'Change photo' : 'Add photo';
  $('#removePhoto').hidden = !pendingPhoto;
}
$('#memberName').oninput = paintProfilePhoto;
$('#photoInput').onchange = async () => {
  const file = $('#photoInput').files[0];
  $('#photoInput').value = '';
  if (!file) return;
  try { pendingPhoto = await squarePhoto(file); paintProfilePhoto(); }
  catch { toast('That photo could not be opened. Try a different one.'); }
};
$('#removePhoto').onclick = () => { pendingPhoto = ''; paintProfilePhoto(); };
// Preview the look immediately; Cancel, Escape, or closing without saving restores the saved choice.
$$('#profileForm [name=theme]').forEach(radio => radio.onchange = () => applyTheme(radio.value));
$('#memberDialog').addEventListener('close', () => {
  applyTheme();
  if (profileMode !== 'profile' && !picked) { try { sessionStorage.setItem('familyMealsPickerDismissed', '1'); } catch {} }
});
$('#pickShowAll').onclick = () => { pickerAll = true; renderPicker(); };
$('#pickNew').onclick = () => {
  setProfileMode('new');
  $('#profileTitle').textContent = 'What’s your name?';
  $('#profileHint').textContent = 'Add yourself to the family.';
  $('#memberName').value = ''; $('#memberName').focus();
};
$('#profileForm').onsubmit = event => {
  event.preventDefault();
  const name = $('#memberName').value.trim(); if (!name) return;
  const previousName = member;
  member = name; localStorage.setItem('familyMealsMember', member);
  try {
    if (pendingPhoto) localStorage.setItem('familyMealsPhoto', pendingPhoto); else localStorage.removeItem('familyMealsPhoto');
    photo = pendingPhoto;
  } catch { toast('Could not save the photo on this device.'); }
  savedTheme = $('#profileForm [name=theme]:checked')?.value || savedTheme;
  try { localStorage.setItem('familyMealsTheme', savedTheme); } catch {}
  $('#memberDialog').close(); render(); toast('Profile saved');
  picked = true;
  registerSelf(previousName).then(() => { renderWeek(); });
};
$$('.tab').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
$$('.close-dialog').forEach(button => button.onclick = () => button.closest('dialog').close());
$$('[data-week-offset]').forEach(button => button.onclick = () => navigateWeek(+button.dataset.weekOffset));
$$('[data-week-home]').forEach(button => button.onclick = () => { if (weekOffset) navigateWeek(-weekOffset); });
$('#addMeal').onclick = () => $('#mealDialog').showModal();
$('#tagFilter').onchange = () => { tagFilter = $('#tagFilter').value; renderMeals(); };
$('#mealSearch').oninput = renderMeals;
async function importRecipe() {
  const url = $('#recipeUrl').value.trim();
  if (!url) return toast('Paste a recipe link first.');
  const { source, draft } = await send('/meals/import', 'POST', { url });
  $('#mealName').value = draft.name;
  if (draft.notes) $('#mealNotes').value = draft.notes;
  if (draft.tags.length) $('#mealTags').value = draft.tags.join(', ');
  if (draft.ingredients.length) $('#ingredients').value = draft.ingredients.join('\n');
  toast(source === 'recipe' ? 'Recipe filled in. Check it, then tap Add idea.' : "Couldn't read the recipe, so only the name was filled in.");
}
$('#importRecipe').onclick = event => action(event.currentTarget, importRecipe);
// Pasting a link into an empty form fills it in right away.
$('#recipeUrl').onpaste = () => setTimeout(() => { if (!$('#mealName').value.trim()) action($('#importRecipe'), importRecipe); });
$('#mealForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    await send('/meals', 'POST', { ...mealPayload(), suggested_by: member });
    $('#mealDialog').close(); event.target.reset(); await refresh(); toast('Meal idea added');
  });
};
$('#editMealForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    await send('/meals', 'PUT', { ...mealPayload(true), id: activeMeal });
    $('#editMealDialog').close(); await refresh(); toast('Meal updated');
  });
};
$('#deleteMeal').onclick = event => action(event.currentTarget, async () => {
  const meal = data.meals.find(m => +m.id === activeMeal);
  if (!meal || !confirm(`Delete "${meal.name}"?\n\nThis removes its ratings, votes, ingredients, and entries in the dinner plan, including past plans.`)) return;
  await send('/meals', 'DELETE', { id: activeMeal });
  draft = null; $('#editMealDialog').close(); await refresh(); toast('Meal deleted');
});
$('#rateForm').onsubmit = event => {
  event.preventDefault(); if (!selectedRating) return toast('Choose 1–5 stars');
  action(event.submitter, async () => {
    await send('/rate', 'POST', { meal_id: activeMeal, member, rating: selectedRating, comment: $('#ratingComment').value });
    $('#rateDialog').close(); await refresh(); toast('Rating saved');
  });
};
$('#suggestSwap').onclick = suggestSwap;
$('#editFamily').onclick = () => { familyEdit = !familyEdit; renderWho(); };
const submitPerson = () => action($('#addPersonSave'), async () => {
  const name = $('#newPerson').value.trim().replace(/\s+/g, ' ');
  if (!name) return;
  const result = await send('/members', 'POST', { name });
  if (!data.members.some(m => sameName(m, result.name))) { data.members.push(result.name); data.unclaimed.push(result.name); }
  $('#newPerson').value = ''; $('#addPerson').hidden = true;
  renderWho(); renderWeek();
});
$('#addPersonSave').onclick = submitPerson;
// Enter adds the person instead of saving the whole dinner popup.
$('#newPerson').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); submitPerson(); } };
$('#planForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    const row = { plan_date: activeDate, meal_id: +$('#planMeal').value || null, note: $('#planNote').value };
    if (draft) { draft = draft.map(p => p.plan_date === activeDate ? row : p); renderWeek(); }
    else { await send('/plan', 'POST', row); await refresh(); }
    $('#planDialog').close(); toast(draft ? 'Preview updated' : 'Dinner planned');
  });
};
$('#planMyWeek').onclick = event => action(event.currentTarget, async () => {
  await refresh(); draftRevision = data.plan_revision;
  draft = proposeWeek(data.meals, data.plan, monday(), today()); renderWeek();
});
$('#cancelPreview').onclick = event => action(event.currentTarget, async () => { draft = null; renderWeek(); await refresh(); });
$('#acceptWeek').onclick = event => action(event.currentTarget, async () => {
  await send('/plan/week', 'POST', { week_start: monday(), days: draft, expected_revision: draftRevision });
  draft = null; await refresh(); toast('Week saved. Your grocery list is ready.');
});
$('#openGroceries').onclick = () => { setCurrentList(GROCERY); switchTab('groceries'); };
$('#refreshGroceries').onclick = loadGroceries;
$('#groceryForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    const store = $('#groceryStore').value.trim();
    // Show the new item even if a different store is being filtered.
    if (storeFilter && (storeFilter === NO_STORE ? store : store.toLowerCase() !== storeFilter.toLowerCase())) storeFilter = '';
    await send('/groceries', 'POST', { week_start: monday(), label: $('#groceryItem').value, store });
    $('#groceryItem').value = ''; await loadGroceries();
  });
};
$('#storeFilter').onchange = () => {
  storeFilter = $('#storeFilter').value;
  $('#groceryStore').value = storeFilter && storeFilter !== NO_STORE ? storeFilter : '';
  renderGroceries();
};
$('#storeForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    const item = storeTarget;
    if (item.kind === 'list') {
      await send('/lists/items', 'PATCH', { list_id: item.list_id, id: item.id, store: $('#storeInput').value });
      $('#storeDialog').close(); return loadCustom();
    }
    await send('/groceries/store', 'POST', { week_start: groceryState.start, kind: item.kind, id: item.id, key: item.key, store: $('#storeInput').value });
    $('#storeDialog').close(); await loadGroceries();
  });
};
$('#clearStore').onclick = () => { $('#storeInput').value = ''; $('#storeForm').requestSubmit(); };
// ---- Lists tab ----
function setCurrentList(id) {
  currentList = String(id);
  try { localStorage.setItem(listKey(), currentList); } catch {}
}
async function loadLists() {
  const requestId = ++listsRequest;
  // Switching profiles on this phone shows that person's lists, starting where they left off.
  if (!sameName(listsOwner, member)) { listsOwner = member; lists = []; customState = null; customFilter = ''; currentList = savedList(); }
  renderListPicker(); showList();
  try {
    const result = await api('/lists');
    if (requestId !== listsRequest) return;
    needsName = false;
    lists = result.lists;
    // A list deleted on another phone falls back to the Grocery List.
    if (currentList !== GROCERY && !lists.some(l => String(l.id) === currentList)) { setCurrentList(GROCERY); showList(); }
    renderListPicker();
  } catch (error) {
    if (requestId !== listsRequest) return;
    if (error.status !== 403) return toast(error.message);
    // No family name on this phone yet: the shared Grocery List still works.
    needsName = true; lists = [];
    if (currentList !== GROCERY) { currentList = GROCERY; showList(); }
    renderListPicker();
  }
}
function renderListPicker() {
  const chip = (id, name, extra = '') => `<button type="button" class="list-chip${currentList === String(id) ? ' active' : ''}" data-list="${id}" aria-pressed="${currentList === String(id)}"><span class="name">${esc(name)}</span>${extra}</button>`;
  $('#listPicker').innerHTML = chip(GROCERY, 'Grocery List') +
    lists.map(l => { const left = l.item_count - l.checked_count; return chip(l.id, l.name, (l.shared ? `${PEOPLE}<span class="sr-only">${l.mine ? 'shared by you' : 'shared by ' + esc(l.owner)}</span>` : '') + (left ? `<span class="count" aria-label="${left} to go">${left}</span>` : '')); }).join('') +
    `<button type="button" class="list-chip new" id="newList">${needsName ? 'Pick your name' : '+ New list'}</button>`;
  $$('[data-list]').forEach(button => button.onclick = () => selectList(button.dataset.list));
  $('#newList').onclick = () => needsName ? openProfile() : openListDialog(null);
  $('#listPicker .active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function selectList(id) {
  if (String(id) === currentList) return;
  setCurrentList(id); customFilter = ''; renderListPicker(); showList();
}
function showList() {
  const grocery = currentList === GROCERY;
  $('#groceryView').hidden = !grocery;
  $('#customView').hidden = grocery;
  if (grocery) loadGroceries();
  else loadCustom();
}
async function loadCustom() {
  const requestId = ++customRequest, id = currentList;
  if (customState?.list && String(customState.list.id) !== id) { customState = null; $('#customList').innerHTML = ''; $('#customTitle').textContent = lists.find(l => String(l.id) === id)?.name || 'List'; }
  $('#customStatus').textContent = 'Loading your list…';
  try {
    const result = await api('/lists/items?list=' + encodeURIComponent(id));
    if (requestId !== customRequest) return;
    customState = result;
    const summary = lists.find(l => l.id === result.list.id);
    if (summary) Object.assign(summary, result.list, { item_count: result.items.length, checked_count: result.items.filter(i => i.checked).length });
    renderListPicker(); renderCustom();
  } catch (error) {
    if (requestId !== customRequest) return;
    if (error.status === 404) { setCurrentList(GROCERY); toast('That list was deleted.'); return loadLists(); }
    $('#customStatus').textContent = error.message;
  }
}
function renderCustom() {
  const { list, items, stores } = customState, grocery = list.kind === 'grocery';
  knownStores = stores;
  $('#storeOptions').innerHTML = stores.map(store => `<option value="${esc(store)}">`).join('');
  $('#customTitle').textContent = list.name;
  $('#customOwner').innerHTML = list.mine ? (list.shared ? `${PEOPLE} Shared with the family` : 'Only you can see this list') : `${PEOPLE} Shared by ${esc(list.owner)}`;
  $('#customOwner').classList.toggle('shared', list.shared);
  $('#editList').hidden = !list.mine;
  const listStores = grocery ? [...new Set(items.map(item => item.store).filter(Boolean))].sort((a, b) => a.localeCompare(b)) : [];
  const unassigned = items.filter(item => !item.store).length;
  if (!listStores.length || (customFilter === NO_STORE ? !unassigned : customFilter && !listStores.includes(customFilter))) customFilter = '';
  $('#customStoreBar').hidden = !listStores.length;
  $('#customStoreFilter').innerHTML = `<option value="">All stores (${items.length})</option>` +
    listStores.map(store => `<option value="${esc(store)}" ${store === customFilter ? 'selected' : ''}>${esc(store)} (${items.filter(item => item.store === store).length})</option>`).join('') +
    (listStores.length && unassigned ? `<option value="${NO_STORE}" ${customFilter === NO_STORE ? 'selected' : ''}>No store yet (${unassigned})</option>` : '');
  const shown = items.map((item, i) => ({ item, i })).filter(({ item }) => !customFilter || (customFilter === NO_STORE ? !item.store : item.store === customFilter));
  const checked = shown.filter(({ item }) => item.checked).length;
  $('#customStatus').textContent = `${checked} of ${shown.length} checked · ${grocery ? 'Grocery list' : 'Basic list'}${customFilter ? (customFilter === NO_STORE ? ' · no store yet' : ' · ' + customFilter) : ''}`;
  $('#clearChecked').hidden = !items.some(item => item.checked);
  $('#customStore').hidden = !grocery;
  $('#customForm').classList.toggle('basic', !grocery);
  $('#customList').innerHTML = shown.map(({ item, i }) => `<div class="grocery-item ${item.checked ? 'checked' : ''}"><label><input type="checkbox" data-item="${i}" ${item.checked ? 'checked' : ''}><span><strong>${esc(item.label)}</strong></span></label>${grocery ? `<button class="chip store-chip ${item.store ? 'set' : ''}" data-item="${i}" aria-label="${item.store ? `Store for ${esc(item.label)}: ${esc(item.store)}. Change store` : `Choose a store for ${esc(item.label)}`}">${item.store ? esc(item.store) : '+ Store'}</button>` : ''}<button class="ghost edit-item" data-item="${i}" aria-label="Edit ${esc(item.label)}">${PENCIL}</button></div>`).join('')
    || `<div class="card auth-card">${items.length ? 'Nothing for this store.' : 'Nothing on this list yet. Add the first item below.'}</div>`;
  const target = i => ({ ...items[i], kind: 'list', list_id: list.id });
  $$('#customList input').forEach(input => input.onchange = () => action(input, async () => {
    const item = target(+input.dataset.item);
    try { await send('/lists/items', 'PATCH', { list_id: list.id, id: item.id, checked: input.checked }); }
    catch (error) { input.checked = !input.checked; throw error; }
    await loadCustom();
  }));
  $$('#customList .edit-item').forEach(button => button.onclick = () => openItem(target(+button.dataset.item)));
  $$('#customList .store-chip').forEach(button => button.onclick = () => openStore(target(+button.dataset.item)));
}
$('#customStoreFilter').onchange = () => {
  customFilter = $('#customStoreFilter').value;
  $('#customStore').value = customFilter && customFilter !== NO_STORE ? customFilter : '';
  renderCustom();
};
$('#customForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    const grocery = customState.list.kind === 'grocery', store = grocery ? $('#customStore').value.trim() : '';
    if (customFilter && (customFilter === NO_STORE ? store : store.toLowerCase() !== customFilter.toLowerCase())) customFilter = '';
    await send('/lists/items', 'POST', { list_id: customState.list.id, label: $('#customItem').value, store });
    $('#customItem').value = ''; $('#customItem').focus(); await loadCustom();
  });
};
$('#clearChecked').onclick = event => {
  const n = customState.items.filter(item => item.checked).length;
  if (!confirm(`Remove ${n} checked item${n > 1 ? 's' : ''} from ${customState.list.name}?`)) return;
  action(event.currentTarget, async () => { await send('/lists/items', 'DELETE', { list_id: customState.list.id, checked: true }); await loadCustom(); });
};
const KIND_HINTS = { grocery: 'Tag items with a store and filter the list by store.', basic: 'A simple checklist — just items, no stores.' };
function paintKindHint() { $('#listKindHint').textContent = KIND_HINTS[$('#listForm [name=listKind]:checked').value]; }
$$('#listForm [name=listKind]').forEach(input => input.onchange = paintKindHint);
function paintShareHint() {
  $('#listShareHint').textContent = $('#listShared').checked ? 'Everyone can see, add to, and check off this list. Only you can rename, unshare, or delete it.' : 'Only you can see this list.';
}
$('#listShared').onchange = paintShareHint;
function openListDialog(list) {
  editingList = list;
  $('#listDialogTitle').textContent = list ? 'Edit list' : 'New list';
  $('#saveList').textContent = list ? 'Save' : 'Create list';
  $('#listName').value = list ? list.name : '';
  $(`#listForm [name=listKind][value=${list ? list.kind : 'grocery'}]`).checked = true;
  $('#deleteList').hidden = !list;
  $('#listShared').checked = !!list?.shared;
  paintKindHint(); paintShareHint();
  $('#listDialog').showModal();
  if (!list) $('#listName').focus();
}
$('#editList').onclick = () => customState && openListDialog(customState.list);
$('#listForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    const payload = { name: $('#listName').value, kind: $('#listForm [name=listKind]:checked').value, shared: $('#listShared').checked };
    const wasShared = !!editingList?.shared;
    if (wasShared && !payload.shared && !confirm(`Stop sharing “${editingList.name}”? The rest of the family will no longer see it.`)) return;
    if (editingList) await send('/lists', 'PUT', { id: editingList.id, ...payload });
    else { const result = await send('/lists', 'POST', payload); setCurrentList(result.id); customFilter = ''; }
    $('#listDialog').close();
    if (payload.shared !== wasShared) toast(payload.shared ? `${payload.name.trim()} is shared with the family.` : `${payload.name.trim()} is private again.`);
    await loadLists();
  });
};
$('#deleteList').onclick = event => {
  const list = editingList, n = customState?.items.length || 0;
  if (!confirm(`Delete “${list.name}”${n ? ` and its ${n} item${n > 1 ? 's' : ''}` : ''}${list.shared ? ' for the whole family' : ''}? This can't be undone.`)) return;
  action(event.currentTarget, async () => {
    await send('/lists', 'DELETE', { id: list.id });
    setCurrentList(GROCERY); $('#listDialog').close(); toast(`Deleted ${list.name}.`); await loadLists();
  });
};
// ---- Chores tab ----
// A day-by-day checklist. Recurring chores come back on their own; completions are kept per chore and date.
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const isoDay = date => new Date(date + 'T12:00:00Z').getUTCDay() || 7;
const choreOn = (c, date) => date >= c.start_date && (c.repeat === 'daily' || (c.repeat === 'once' && date === c.start_date) || (c.repeat === 'weekly' && c.days.includes(isoDay(date))));
const shortDate = value => new Date(value + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
let choreDate = today(), choreState = null, choreRequest = 0, choreScope = 'all', editingChore = null, choreDays = [], choreWho = [];
const choreWeek = date => addDays(date, 1 - isoDay(date));
const choreDone = (chore, date) => choreState.done.find(d => d.chore_id === chore.id && d.due_date === date);
async function loadChores() {
  const requestId = ++choreRequest, start = choreWeek(choreDate);
  $('#choreStatus').textContent = 'Loading chores…';
  try {
    const result = await api('/chores?week=' + start);
    if (requestId !== choreRequest) return;
    choreState = { ...result, start };
    renderChores();
  } catch (error) { if (requestId === choreRequest) $('#choreStatus').textContent = error.message; }
}
function stepChoreDay(days) {
  choreDate = days === 0 ? today() : addDays(choreDate, days);
  if (choreState?.start === choreWeek(choreDate)) renderChores(); else { renderChoreHeader(); loadChores(); }
}
function renderChoreHeader() {
  const now = today();
  $('#choreTitle').textContent = choreDate === now ? 'Today' : choreDate === addDays(now, 1) ? 'Tomorrow' : choreDate === addDays(now, -1) ? 'Yesterday' : new Date(choreDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' });
  $('#choreLabel').textContent = displayDate(choreDate);
  const away = choreDate !== now, days = Math.abs(daysBetween(now, choreDate));
  const button = $('#choreToday');
  button.classList.toggle('away', away);
  button.setAttribute('aria-disabled', String(!away));
  button.setAttribute('aria-label', away ? `Back to today (${days} day${days > 1 ? 's' : ''} ${choreDate > now ? 'ahead' : 'back'})` : 'Showing today');
  button.title = away ? 'Back to today' : 'You are on today';
}
const choreRepeatText = c => c.repeat === 'daily' ? 'Every day' : c.repeat === 'weekly' ? 'Weekly · ' + c.days.map(d => DAY_NAMES[d - 1]).join(', ') : 'One time';
function renderChores() {
  if (!choreState) return;
  renderChoreHeader();
  const { chores } = choreState, date = choreDate, isToday = date === today();
  const forMe = c => !c.assignees.length || c.assignees.some(name => sameName(name, member));
  const rows = [];
  for (const chore of chores) {
    if (choreScope === 'mine' && !forMe(chore)) continue;
    if (choreOn(chore, date)) rows.push({ chore, date, done: choreDone(chore, date) });
    // A one-time chore nobody finished stays on today's list until it is done.
    else if (isToday && chore.repeat === 'once' && chore.start_date < date && !choreState.done.some(d => d.chore_id === chore.id)) rows.push({ chore, date: chore.start_date, overdue: true });
  }
  rows.sort((a, b) => (!!a.done - !!b.done) || (!!b.overdue - !!a.overdue));
  const left = rows.filter(r => !r.done).length;
  $('#choreStatus').textContent = !chores.length ? '' : !rows.length ? '' : left ? `${rows.length - left} of ${rows.length} done` : `All ${rows.length} done 🎉`;
  $('#choreList').innerHTML = rows.map((r, i) => {
    const c = r.chore, who = c.assignees.length ? c.assignees.map(esc).join(', ') : 'Anyone';
    const meta = [r.overdue ? `Overdue · was due ${esc(shortDate(r.date))}` : '', who, esc(choreRepeatText(c)), r.done ? `✓ Done by ${esc(r.done.done_by)}` : ''].filter(Boolean).join(' · ');
    return `<div class="grocery-item chore${r.done ? ' checked' : ''}${r.overdue ? ' overdue' : ''}"><label><input type="checkbox" data-row="${i}" ${r.done ? 'checked' : ''}><span><strong>${esc(c.title)}</strong><small>${meta}</small></span></label><button class="ghost edit-item" data-chore="${c.id}" aria-label="Edit ${esc(c.title)}">${PENCIL}</button></div>`;
  }).join('') || `<div class="card auth-card">${!chores.length ? 'No chores yet. Tap “+ Add chore” to start the list.' : choreScope === 'mine' ? 'Nothing for you this day.' : 'Nothing scheduled this day.'}</div>`;
  $$('#choreList input').forEach(input => input.onchange = () => action(input, async () => {
    if (!member) { input.checked = !input.checked; return openProfile(); }
    const r = rows[+input.dataset.row];
    try { await send('/chores/done', 'POST', { chore_id: r.chore.id, date: r.date, done: input.checked }); }
    catch (error) { input.checked = !input.checked; throw error; }
    await loadChores();
  }));
  $$('#choreList .edit-item').forEach(button => button.onclick = () => openChoreDialog(chores.find(c => c.id === +button.dataset.chore)));
  renderChoreSummary();
}
// This week for the family: how much got done, and by whom.
function renderChoreSummary() {
  const { chores, start, recent } = choreState, box = $('#choreSummary');
  box.hidden = !chores.length;
  if (chores.length) {
    let scheduled = 0, finished = 0;
    const credit = new Map(data.members.map(name => [name.toLowerCase(), { name, n: 0 }]));
    for (const date of weekDates(start)) for (const chore of chores) {
      if (!choreOn(chore, date)) continue;
      scheduled++;
      const row = choreDone(chore, date);
      if (!row) continue;
      finished++;
      const key = row.done_by.toLowerCase();
      if (!credit.has(key)) credit.set(key, { name: row.done_by, n: 0 });
      credit.get(key).n++;
    }
    const people = [...credit.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const pct = scheduled ? Math.round(finished / scheduled * 100) : 0;
    box.innerHTML = `<p class="eyebrow">${start === choreWeek(today()) ? 'THIS WEEK' : `WEEK OF ${esc(displayDate(start).toUpperCase())}`}</p><strong>${finished} of ${scheduled} chores done</strong><div class="meter" role="img" aria-label="${pct} percent done"><i style="width:${pct}%"></i></div>${people.some(p => p.n) ? `<div class="chips">${people.map(p => `<span class="chip${p.n ? ' voted' : ''}">${esc(p.name)} · ${p.n}</span>`).join('')}</div>` : '<p class="hint">Nothing checked off yet this week.</p>'}`;
  }
  $('#choreRecent').hidden = !recent.length;
  $('#choreRecentList').innerHTML = recent.map(r => `<li><strong>${esc(r.done_by)}</strong> did ${esc(r.title)} · ${esc(shortDate(r.due_date))}</li>`).join('');
}
$$('[data-chore-step]').forEach(button => button.onclick = () => stepChoreDay(+button.dataset.choreStep));
$('#choreToday').onclick = () => { if (choreDate !== today()) stepChoreDay(0); };
$$('[name=choreScope]').forEach(radio => radio.onchange = () => { choreScope = $('[name=choreScope]:checked').value; renderChores(); });
function renderChoreDialogChips() {
  $('#choreDays').innerHTML = DAY_NAMES.map((name, i) => `<button type="button" class="chip${choreDays.includes(i + 1) ? ' voted' : ''}" data-day="${i + 1}" aria-pressed="${choreDays.includes(i + 1)}">${name}</button>`).join('');
  $$('#choreDays [data-day]').forEach(button => button.onclick = () => {
    const day = +button.dataset.day;
    choreDays = choreDays.includes(day) ? choreDays.filter(d => d !== day) : [...choreDays, day];
    renderChoreDialogChips();
  });
  $('#choreWho').innerHTML = data.members.map(name => { const on = choreWho.some(w => sameName(w, name)); return `<button type="button" class="chip${on ? ' voted' : ''}" data-who="${esc(name)}" aria-pressed="${on}">${esc(name)}</button>`; }).join('');
  $$('#choreWho [data-who]').forEach(button => button.onclick = () => {
    const name = button.dataset.who;
    choreWho = choreWho.some(w => sameName(w, name)) ? choreWho.filter(w => !sameName(w, name)) : [...choreWho, name];
    renderChoreDialogChips();
  });
  $('#choreWhoHint').textContent = !data.members.length ? 'Add your name in your profile to assign chores.' : choreWho.length ? 'Only these people see it under “Mine”.' : 'No one picked — anyone can do it.';
}
function paintChoreRepeat() {
  const repeat = $('[name=choreRepeat]:checked').value;
  $('#choreDaysField').hidden = repeat !== 'weekly';
  $('#choreDateLabel').textContent = repeat === 'once' ? 'Due date' : 'Starts on';
}
$$('[name=choreRepeat]').forEach(radio => radio.onchange = () => {
  if ($('[name=choreRepeat]:checked').value === 'weekly' && !choreDays.length && $('#choreDate').value) choreDays = [isoDay($('#choreDate').value)];
  paintChoreRepeat(); renderChoreDialogChips();
});
function openChoreDialog(chore) {
  if (!chore && !member) return openProfile();
  editingChore = chore || null;
  $('#choreDialogTitle').textContent = chore ? 'Edit chore' : 'New chore';
  $('#saveChore').textContent = chore ? 'Save' : 'Add chore';
  $('#deleteChore').hidden = !chore;
  $('#choreName').value = chore?.title || '';
  $(`[name=choreRepeat][value=${chore?.repeat || 'once'}]`).checked = true;
  $('#choreDate').value = chore?.start_date || choreDate;
  choreDays = chore ? [...chore.days] : [];
  choreWho = chore ? chore.assignees.filter(name => data.members.some(m => sameName(m, name))) : [];
  paintChoreRepeat(); renderChoreDialogChips();
  $('#choreDialog').showModal();
  if (!chore) $('#choreName').focus();
}
$('#addChore').onclick = () => openChoreDialog(null);
$('#choreForm').onsubmit = event => {
  event.preventDefault(); action(event.submitter, async () => {
    const repeat = $('[name=choreRepeat]:checked').value;
    if (repeat === 'weekly' && !choreDays.length) return toast('Choose at least one day of the week.');
    const payload = { title: $('#choreName').value, repeat, days: choreDays, start_date: $('#choreDate').value, assignees: choreWho };
    const result = editingChore ? await send('/chores', 'PUT', { id: editingChore.id, ...payload }) : await send('/chores', 'POST', payload);
    $('#choreDialog').close();
    // Show the day the chore starts on, so a new chore is never "missing" from the screen.
    if (!editingChore && payload.start_date > choreDate && repeat === 'once') choreDate = payload.start_date;
    await loadChores(); toast(editingChore ? 'Chore updated' : 'Chore added');
  });
};
$('#deleteChore').onclick = event => {
  const chore = editingChore;
  if (!confirm(`Delete “${chore.title}”?\n\nIt disappears for the whole family, along with its history.`)) return;
  action(event.currentTarget, async () => {
    await send('/chores', 'DELETE', { id: chore.id });
    $('#choreDialog').close(); await loadChores(); toast('Chore deleted');
  });
};
if (pin) load();
