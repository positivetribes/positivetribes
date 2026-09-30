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
  const response = await fetch('/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-family-pin': pin } });
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
  if ($('#groceries').classList.contains('active')) loadGroceries();
}
function switchTab(id) {
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === id));
  $$('.panel').forEach(panel => panel.classList.toggle('active', panel.id === id));
  if (id === 'groceries') loadGroceries();
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
    return `<div class="day-row${date === today() ? ' today' : ''}"><button class="day" data-date="${date}"${date === today() ? ' aria-current="date"' : ''} aria-label="Choose dinner for ${esc(displayDate(date))}${date === today() ? ' (today)' : ''}"><div><div class="dayname">${new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</div><div class="date">${new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div></div><div><div class="meal-title">${esc(meal?.name || row?.note || 'Pick a meal')}</div><div class="meal-sub">${esc(row?.reason || (meal && row?.note) || (draft ? 'Choose or swap before accepting' : 'Tap to plan dinner'))}</div>${homeLine(date)}</div><span>›</span></button>${date >= today() ? `<button class="swap ghost" data-date="${date}" aria-label="Suggest another dinner for ${esc(displayDate(date))}">Swap</button>` : ''}</div>`;
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
  if ($('#groceries').classList.contains('active')) await loadGroceries();
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
  $('#storeOptions').innerHTML = result.stores.map(store => `<option value="${esc(store)}">`).join('');
  const shown = items.map((item, i) => ({ item, i })).filter(({ item }) => !storeFilter || (storeFilter === NO_STORE ? !item.store : item.store === storeFilter));
  $('#groceryStatus').textContent = `${shown.filter(({ item }) => item.checked).length} of ${shown.length} checked${storeFilter ? (storeFilter === NO_STORE ? ' · no store yet' : ' · ' + storeFilter) : ''} · ${result.planned_count} planned dinners${draft ? ' · Preview is not saved yet' : ''}`;
  $('#missingIngredients').innerHTML = result.missing.length ? `<p class="hint">Add ingredients to complete the list:</p><div class="chips">${result.missing.map(meal => `<button class="chip missing-meal" data-id="${meal.id}">${esc(meal.name)} +</button>`).join('')}</div>` : '';
  $$('.missing-meal').forEach(button => button.onclick = () => openEditMeal(button.dataset.id));
  $('#groceryList').innerHTML = shown.map(({ item, i }) => `<div class="grocery-item ${item.checked ? 'checked' : ''}"><label><input type="checkbox" data-item="${i}" ${item.checked ? 'checked' : ''}><span><strong>${esc(item.label)}${item.count > 1 ? ` × ${item.count} meals` : ''}</strong><small>${item.kind === 'manual' ? 'Added by your family' : esc(item.meals.join(' · '))}</small></span></label><button class="chip store-chip ${item.store ? 'set' : ''}" data-item="${i}" aria-label="${item.store ? `Store for ${esc(item.label)}: ${esc(item.store)}. Change store` : `Choose a store for ${esc(item.label)}`}">${item.store ? esc(item.store) : '+ Store'}</button>${item.kind === 'manual' ? `<button class="ghost remove-item" data-item="${i}" aria-label="Remove ${esc(item.label)}">×</button>` : ''}</div>`).join('') || '<div class="card auth-card">Plan dinners and add their ingredients, or add an item below.</div>';
  $$('#groceryList input').forEach(input => input.onchange = () => action(input, async () => {
    const item = items[+input.dataset.item];
    try { await send('/groceries', 'PATCH', { week_start: start, kind: item.kind, id: item.id, key: item.key, checked: input.checked }); }
    catch (error) { input.checked = !input.checked; throw error; }
    await loadGroceries();
  }));
  $$('.remove-item').forEach(button => button.onclick = () => action(button, async () => {
    await send('/groceries', 'DELETE', { week_start: start, kind: 'manual', id: items[+button.dataset.item].id });
    await loadGroceries();
  }));
  $$('.store-chip').forEach(button => button.onclick = () => openStore(items[+button.dataset.item]));
}
function openStore(item) {
  storeTarget = item;
  $('#storeTitle').textContent = `Where to buy ${item.label}`;
  $('#storeInput').value = item.store || '';
  $('#storeChips').innerHTML = groceryState.result.stores.map(store => `<button type="button" class="chip pick-store ${store === item.store ? 'voted' : ''}" data-store="${esc(store)}">${esc(store)}</button>`).join('');
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
$('#openGroceries').onclick = () => switchTab('groceries');
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
    const item = storeTarget, start = groceryState.start;
    await send('/groceries/store', 'POST', { week_start: start, kind: item.kind, id: item.id, key: item.key, store: $('#storeInput').value });
    $('#storeDialog').close(); await loadGroceries();
  });
};
$('#clearStore').onclick = () => { $('#storeInput').value = ''; $('#storeForm').requestSubmit(); };
if (pin) load();
