(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const STORAGE_KEY         = 'calorieTrackerData';
  const KCAL_PER_STEP       = 0.04;
  const KCAL_PER_KG         = 7700;
  const CALORIE_NINJAS_URL  = 'https://api.calorieninjas.com/v1/nutrition';
  const DEFAULT_PROFILE     = { name: 'Shira', weight: 70, height: 165, age: 27, gender: 'female', stepGoal: 10000, deficitGoal: 500, weightGoal: 0, calorieNinjasKey: 'aYkVbcqJfi+EIpYkAqDHNw==dFnnPb7SLy7CToiQ' };
  const NICKNAMES           = ['Balu', 'Hunta patata', 'Shula', 'Shablula', 'King', 'King of the world'];

  const MEAL_META = {
    breakfast: { label: '🌅 Breakfast' },
    lunch:     { label: '☀️ Lunch' },
    dinner:    { label: '🌙 Dinner' },
    snack:     { label: '🍎 Snack' },
    other:     { label: '🍴 Other' },
  };
  const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

  function getDisplayName(baseName) {
    const pool = [baseName, ...NICKNAMES];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function getMealDefault() {
    const h = new Date().getHours();
    if (h >= 5  && h < 10) return 'breakfast';
    if (h >= 10 && h < 14) return 'lunch';
    if (h >= 17 && h < 22) return 'dinner';
    return 'snack';
  }

  let pendingFoods    = [];
  let pendingMeal     = 'breakfast';
  let pendingQuery    = '';
  let selectedDateKey = getTodayKey();

  const chartInstances = {};

  // ─── Cloud Sync (Firebase) ────────────────────────────────────────────────────
  // Setup: go to console.firebase.google.com → create project → Add web app → copy config here.
  // Then open Firestore Database → Rules and set:
  //   match /users/shira { allow read, write: if true; }
  const FIREBASE_CONFIG = {
    apiKey:            'AIzaSyC-jmoAWTMte7akYiezFUHgq9vAjS_p5Z4',
    authDomain:        'calorie-c751e.firebaseapp.com',
    projectId:         'calorie-c751e',
    storageBucket:     'calorie-c751e.firebasestorage.app',
    messagingSenderId: '350513793118',
    appId:             '1:350513793118:web:4523728a6edee387a18ccf',
  };

  let db = null;

  function initFirebase() {
    if (!FIREBASE_CONFIG.projectId) return;
    try {
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore(app);
    } catch (_) {}
  }

  function cloudSave(data) {
    if (!db) return;
    db.doc('users/shira').set(data).catch(() => {});
  }

  async function cloudLoad() {
    if (!db) return;
    try {
      const snap = await db.doc('users/shira').get();
      if (!snap.exists) return;
      const cloud  = snap.data();
      const cloudTs = cloud._ts || 0;
      const localTs = (loadData()._ts) || 0;
      if (cloudTs <= localTs) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cloud));
      renderGreeting();
      renderWeightLog();
      renderFoodLog();
      renderTodaySummary();
      renderRecentFoods();
      const el = document.getElementById('sync-status');
      if (el) {
        el.textContent = '☁️ Synced from cloud';
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 3000);
      }
    } catch (_) {}
  }

  // ─── Storage ─────────────────────────────────────────────────────────────────

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshData();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return freshData();
      if (!parsed.profile) parsed.profile = { ...DEFAULT_PROFILE };
      parsed.profile = { ...DEFAULT_PROFILE, ...parsed.profile };
      // Never let blank/zero values override the hardcoded defaults
      if (!parsed.profile.calorieNinjasKey) parsed.profile.calorieNinjasKey = DEFAULT_PROFILE.calorieNinjasKey;
      if (!parsed.profile.name)             parsed.profile.name             = DEFAULT_PROFILE.name;
      if (!parsed.profile.age)              parsed.profile.age              = DEFAULT_PROFILE.age;
      if (!parsed.profile.gender)           parsed.profile.gender           = DEFAULT_PROFILE.gender;
      if (!parsed.profile.height)           parsed.profile.height           = DEFAULT_PROFILE.height;
      if (!parsed.profile.stepGoal)         parsed.profile.stepGoal         = DEFAULT_PROFILE.stepGoal;
      if (!parsed.profile.deficitGoal)      parsed.profile.deficitGoal      = DEFAULT_PROFILE.deficitGoal;
      if (!parsed.entries) parsed.entries = {};
      return parsed;
    } catch (_) {
      localStorage.removeItem(STORAGE_KEY);
      return freshData();
    }
  }

  function freshData() {
    return { profile: { ...DEFAULT_PROFILE }, entries: {} };
  }

  function saveData(data) {
    data._ts = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {
      showBanner('Storage unavailable — your data may not be saved.');
    }
    cloudSave(data);
  }

  function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function getOrCreateEntry(data, dateKey) {
    if (!data.entries[dateKey]) {
      data.entries[dateKey] = { steps: 0, foods: [] };
    }
    return data.entries[dateKey];
  }

  // ─── Calorie Math ─────────────────────────────────────────────────────────────

  function calcBMR(profile) {
    const w = Number(profile.weight)  || DEFAULT_PROFILE.weight;
    const h = Number(profile.height)  || DEFAULT_PROFILE.height;
    const a = Number(profile.age)     || DEFAULT_PROFILE.age;
    const g = profile.gender          || DEFAULT_PROFILE.gender;
    const base = 10 * w + 6.25 * h - 5 * a;
    return g === 'female' ? base - 161 : base + 5;
  }

  function calcStepCalories(steps) {
    return (Number(steps) || 0) * KCAL_PER_STEP;
  }

  function calcTotalBurned(profile, steps) {
    return calcBMR(profile) + calcStepCalories(steps);
  }

  function calcConsumed(foods) {
    return (foods || []).reduce((sum, f) => sum + (Number(f.calories) || 0), 0);
  }

  function calcDeficit(burned, consumed) {
    return burned - consumed;
  }

  function calcStreak(data) {
    const deficitGoal = Number(data.profile.deficitGoal) || 500;
    let streak = 0;

    // Count today if goal is already hit
    const todayKey = getTodayKey();
    const todayDeficit = calcDayDeficit(data, todayKey);
    if (todayDeficit !== null && todayDeficit >= deficitGoal) {
      streak++;
    }

    // Walk backwards from yesterday
    for (let i = 1; i <= 365; i++) {
      const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const deficit = calcDayDeficit(data, key);
      if (deficit === null || deficit < deficitGoal) break;
      streak++;
    }

    return streak;
  }

  function calcDayDeficit(data, dateKey) {
    const entry = data.entries[dateKey];
    if (!entry) return null;
    const burned   = calcTotalBurned(data.profile, entry.steps);
    const consumed = calcConsumed(entry.foods);
    return calcDeficit(burned, consumed);
  }

  function calcMacros(foods) {
    return (foods || []).reduce(
      (acc, f) => ({
        protein: acc.protein + (Number(f.protein) || 0),
        carbs:   acc.carbs   + (Number(f.carbs)   || 0),
        fat:     acc.fat     + (Number(f.fat)      || 0),
      }),
      { protein: 0, carbs: 0, fat: 0 }
    );
  }

  function renderMacros() {
    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);
    const m       = calcMacros(entry.foods);
    const total   = m.protein + m.carbs + m.fat;

    const fmt = v => v > 0 ? Math.round(v) : '—';
    document.getElementById('macro-protein').textContent = fmt(m.protein);
    document.getElementById('macro-carbs').textContent   = fmt(m.carbs);
    document.getElementById('macro-fat').textContent     = fmt(m.fat);

    const emptyEl = document.getElementById('macro-empty');
    const wrapEl  = document.querySelector('.macro-chart-wrap');

    if (total === 0) {
      emptyEl.classList.remove('hidden');
      wrapEl.style.display = 'none';
      if (chartInstances['macro-chart']) {
        chartInstances['macro-chart'].destroy();
        delete chartInstances['macro-chart'];
      }
      return;
    }

    emptyEl.classList.add('hidden');
    wrapEl.style.display = '';

    if (chartInstances['macro-chart']) chartInstances['macro-chart'].destroy();
    const ctx = document.getElementById('macro-chart').getContext('2d');
    chartInstances['macro-chart'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Protein', 'Carbs', 'Fat'],
        datasets: [{
          data: [Math.round(m.protein), Math.round(m.carbs), Math.round(m.fat)],
          backgroundColor: ['rgba(65,105,225,0.75)', 'rgba(200,112,0,0.75)', 'rgba(196,96,122,0.75)'],
          borderColor: ['#4169e1', '#c87000', '#c4607a'],
          borderWidth: 1.5,
          hoverOffset: 6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12 } },
          tooltip: { callbacks: { label: c => ` ${c.parsed}g (${Math.round(c.parsed / total * 100)}%)` } }
        }
      }
    });
  }

  function renderWeightLog() {
    const data    = loadData();
    const entry   = data.entries[selectedDateKey];
    const input   = document.getElementById('weight-input');
    input.value   = (entry && entry.weight) ? entry.weight : '';
  }

  // ─── Today Tab ───────────────────────────────────────────────────────────────

  function renderGreeting() {
    const data = loadData();
    const name = getDisplayName((data.profile.name || 'Shira').trim());
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greeting-text').textContent = `${timeGreeting}, ${name}! 🌸`;
    if (selectedDateKey === getTodayKey()) {
      const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      document.getElementById('greeting-sub').textContent = dateStr;
    } else {
      const d = new Date(selectedDateKey + 'T00:00:00');
      const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      document.getElementById('greeting-sub').textContent = `Logging for ${dateStr}`;
    }
  }

  function renderProgress() {
    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);
    const profile = data.profile;
    const name    = getDisplayName((profile.name || 'Shira').trim());

    const stepGoal    = Number(profile.stepGoal)    || 10000;
    const deficitGoal = Number(profile.deficitGoal) || 500;

    // Steps progress
    const currentSteps = Number(entry.steps) || 0;
    const stepPct = Math.min(100, Math.round((currentSteps / stepGoal) * 100));
    document.getElementById('progress-steps-label').textContent =
      `${currentSteps.toLocaleString()} / ${stepGoal.toLocaleString()}`;
    document.getElementById('progress-steps-bar').style.width = `${stepPct}%`;

    const stepsNoteEl = document.getElementById('progress-steps-note');
    const remaining = stepGoal - currentSteps;
    if (currentSteps >= stepGoal) {
      stepsNoteEl.textContent = `You crushed your step goal today, ${name}! ✨`;
      stepsNoteEl.className = 'progress-note achieved';
    } else if (stepPct >= 75) {
      stepsNoteEl.textContent = `Almost there! Just ${remaining.toLocaleString()} more steps — you've got this!`;
      stepsNoteEl.className = 'progress-note';
    } else if (stepPct >= 50) {
      stepsNoteEl.textContent = `More than halfway! ${remaining.toLocaleString()} steps to go.`;
      stepsNoteEl.className = 'progress-note';
    } else if (stepPct >= 25) {
      stepsNoteEl.textContent = `Keep going, ${name}! ${remaining.toLocaleString()} steps to your goal.`;
      stepsNoteEl.className = 'progress-note';
    } else {
      stepsNoteEl.textContent = `Every step counts — ${remaining.toLocaleString()} steps to your daily goal.`;
      stepsNoteEl.className = 'progress-note';
    }

    // Deficit progress
    const burned       = Math.round(calcTotalBurned(profile, entry.steps));
    const consumed     = Math.round(calcConsumed(entry.foods));
    const currentDeficit = burned - consumed;
    const deficitPct   = Math.min(100, Math.max(0, Math.round((currentDeficit / deficitGoal) * 100)));

    document.getElementById('progress-deficit-label').textContent =
      `${currentDeficit.toLocaleString()} / ${deficitGoal.toLocaleString()} kcal`;
    const deficitBar = document.getElementById('progress-deficit-bar');
    deficitBar.style.width = `${deficitPct}%`;

    const deficitNoteEl = document.getElementById('progress-deficit-note');
    if (currentDeficit >= deficitGoal) {
      deficitNoteEl.textContent = `Deficit goal reached! You're incredible, ${name}! 🌟`;
      deficitNoteEl.className = 'progress-note achieved';
      deficitBar.classList.remove('surplus');
    } else {
      const gapKcal     = deficitGoal - currentDeficit;
      const stepsNeeded = Math.ceil(gapKcal / KCAL_PER_STEP);
      let msg;
      if (currentDeficit < 0) {
        msg = `You're in a surplus today — log more activity or eat a little less!`;
      } else if (deficitPct >= 75) {
        msg = `Almost at your deficit goal! Just ${gapKcal.toLocaleString()} kcal away.`;
      } else if (deficitPct >= 50) {
        msg = `Halfway there! ${stepsNeeded.toLocaleString()} more steps would close the gap.`;
      } else {
        msg = `${stepsNeeded.toLocaleString()} more steps needed to hit your deficit goal.`;
      }
      deficitNoteEl.textContent = msg;
      deficitNoteEl.className = 'progress-note';
      deficitBar.classList.toggle('surplus', currentDeficit < 0);
    }

    // Streak
    document.getElementById('streak-count').textContent = calcStreak(data);
  }

  function renderTodaySummary() {
    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);
    const name    = getDisplayName((data.profile.name || 'Shira').trim());
    const burned  = Math.round(calcTotalBurned(data.profile, entry.steps));
    const consumed = Math.round(calcConsumed(entry.foods));
    const deficit  = burned - consumed;

    document.getElementById('stat-burned').textContent   = burned.toLocaleString();
    document.getElementById('stat-consumed').textContent = consumed.toLocaleString();
    document.getElementById('stat-deficit').textContent  = deficit.toLocaleString();

    const deficitBox = document.getElementById('deficit-box');
    const note       = document.getElementById('deficit-note');
    if (deficit >= 0) {
      deficitBox.classList.add('positive');
      deficitBox.classList.remove('negative');
      note.textContent = `You're in a calorie deficit today, ${name}. Keep it up! 💪`;
    } else {
      deficitBox.classList.add('negative');
      deficitBox.classList.remove('positive');
      note.textContent = `You're in a calorie surplus today — no worries, tomorrow is a fresh start!`;
    }

    renderProgress();
    renderMacros();
    renderWeightProgress();
  }

  function calcWeightProgress(data) {
    const goalWeight = Number(data.profile.weightGoal) || 0;
    if (!goalWeight) return null;

    const recentWeight = [...getPastDays(30)].reverse()
      .map(k => data.entries[k] && data.entries[k].weight)
      .find(w => w && w > 0) || data.profile.weight || null;
    if (!recentWeight || goalWeight >= recentWeight) return null;

    const peakWeight = Object.values(data.entries)
      .map(e => e.weight).filter(w => w && w > 0)
      .reduce((max, w) => Math.max(max, w), data.profile.weight || 0);

    const totalToLose = peakWeight - goalWeight;
    if (totalToLose <= 0) return null;

    const lostSoPeak = +(peakWeight - recentWeight).toFixed(1);
    const remaining  = +(recentWeight - goalWeight).toFixed(1);
    const pct        = Math.min(100, Math.max(0, Math.round((lostSoPeak / totalToLose) * 100)));
    return { recentWeight, goalWeight, lostSoPeak, remaining, pct };
  }

  function renderWeightProgress() {
    const data = loadData();
    const prog = calcWeightProgress(data);
    const wrap = document.getElementById('weight-goal-progress');
    if (!prog) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');

    document.getElementById('wg-bar').style.width   = `${prog.pct}%`;
    document.getElementById('wg-label').textContent = `${prog.recentWeight} kg → ${prog.goalWeight} kg`;
    document.getElementById('wg-note').textContent  = prog.lostSoPeak > 0
      ? `${prog.lostSoPeak} kg lost · ${prog.remaining} kg to go`
      : `${prog.remaining} kg to go`;

    const milestoneEl = document.getElementById('wg-milestone');
    const msg =
      prog.pct >= 100 ? "You've reached your goal weight! 🎉" :
      prog.pct >= 75  ? "Three quarters there — the finish line is in sight! 🏃‍♀️" :
      prog.pct >= 50  ? "Halfway to your goal! Keep it up! 💪" :
      prog.pct >= 25  ? "A quarter of the way there! 🌟" : '';
    milestoneEl.textContent = msg;
    milestoneEl.classList.toggle('hidden', !msg);
  }

  function renderFoodLog() {
    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);
    const list    = document.getElementById('food-log');
    const empty   = document.getElementById('food-log-empty');

    list.innerHTML = '';

    if (!entry.foods || entry.foods.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    // Group foods by meal preserving original indices for deletion
    const groups = {};
    entry.foods.forEach((food, idx) => {
      const meal = food.meal || 'other';
      if (!groups[meal]) groups[meal] = [];
      groups[meal].push({ food, idx });
    });

    MEAL_ORDER.forEach(meal => {
      if (!groups[meal]) return;
      const meta       = MEAL_META[meal];
      const items      = groups[meal];
      const groupTotal = Math.round(items.reduce((s, { food }) => s + (Number(food.calories) || 0), 0));

      const groupDiv = document.createElement('div');
      groupDiv.className = 'meal-group';

      const header = document.createElement('div');
      header.className = 'meal-group-header';
      const headerLeft = document.createElement('span');
      headerLeft.textContent = meta.label;
      const headerRight = document.createElement('span');
      headerRight.className = 'meal-group-kcal';
      headerRight.textContent = `${groupTotal.toLocaleString()} kcal`;
      header.appendChild(headerLeft);
      header.appendChild(headerRight);
      groupDiv.appendChild(header);

      const ul = document.createElement('ul');
      items.forEach(({ food, idx }) => {
        const li = document.createElement('li');

        const nameWrap = document.createElement('span');
        nameWrap.className = 'food-log-name';

        const p  = Number(food.protein) || 0;
        const c  = Number(food.carbs)   || 0;
        const fa = Number(food.fat)     || 0;

        const qty      = food.quantity && food.quantity !== 1 ? `×${food.quantity} ` : '';
        const nameStr  = qty + food.name;
        if (p + c + fa > 0) {
          const nameText = document.createElement('span');
          nameText.textContent = nameStr;
          const macroEl = document.createElement('span');
          macroEl.className = 'food-macros';
          macroEl.textContent = `${Math.round(p)}g protein · ${Math.round(c)}g carbs · ${Math.round(fa)}g fat`;
          nameWrap.appendChild(nameText);
          nameWrap.appendChild(macroEl);
        } else {
          nameWrap.textContent = nameStr;
        }

        const kcalSpan = document.createElement('span');
        kcalSpan.className = 'food-log-kcal';
        kcalSpan.textContent = `${Math.round(food.calories)} kcal`;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-food-btn';
        removeBtn.textContent = '✕';
        removeBtn.setAttribute('aria-label', `Remove ${food.name}`);
        removeBtn.addEventListener('click', () => removeFoodEntry(idx));

        li.appendChild(nameWrap);
        li.appendChild(kcalSpan);
        li.appendChild(removeBtn);
        ul.appendChild(li);
      });

      groupDiv.appendChild(ul);
      list.appendChild(groupDiv);
    });
  }

  function removeFoodEntry(idx) {
    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);
    entry.foods.splice(idx, 1);
    saveData(data);
    renderFoodLog();
    renderTodaySummary();
  }

  function initTodayTab() {
    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);

    // Pre-fill steps
    const stepsInput = document.getElementById('steps-input');
    if (entry.steps > 0) stepsInput.value = entry.steps;

    // Date picker
    const datePicker  = document.getElementById('date-picker');
    const todayKey    = getTodayKey();
    datePicker.max    = todayKey;
    datePicker.value  = selectedDateKey;
    datePicker.addEventListener('change', () => {
      if (!datePicker.value) return;
      selectedDateKey = datePicker.value;
      const d = loadData();
      const e = getOrCreateEntry(d, selectedDateKey);
      stepsInput.value = e.steps > 0 ? e.steps : '';
      renderGreeting();
      renderWeightLog();
      renderFoodLog();
      renderTodaySummary();
    });
    document.getElementById('date-today-btn').addEventListener('click', () => {
      selectedDateKey  = getTodayKey();
      datePicker.value = selectedDateKey;
      const d = loadData();
      const e = getOrCreateEntry(d, selectedDateKey);
      stepsInput.value = e.steps > 0 ? e.steps : '';
      renderGreeting();
      renderWeightLog();
      renderFoodLog();
      renderTodaySummary();
    });

    renderGreeting();
    renderWeightLog();
    renderFoodLog();
    renderTodaySummary();
    renderRecentFoods();

    // Auto-apply steps from iOS Shortcut URL parameter (?steps=8432)
    const urlParams = new URLSearchParams(location.search);
    const urlSteps  = urlParams.get('steps');
    if (urlSteps !== null) {
      const autoSteps = Math.round(Number(urlSteps));
      if (isFinite(autoSteps) && autoSteps >= 0) {
        stepsInput.value = autoSteps;
        const d = loadData();
        getOrCreateEntry(d, dateKey).steps = autoSteps;
        saveData(d);
        renderTodaySummary();
      }
      // Remove ?steps= from URL so a refresh doesn't re-apply it
      const clean = location.pathname + location.search
        .replace(/([?&])steps=[^&]*/g, '$1').replace(/[?&]$/, '').replace(/\?&/, '?');
      history.replaceState(null, '', clean || location.pathname);
    }

    // Save weight
    document.getElementById('save-weight-btn').addEventListener('click', () => {
      const val = parseFloat(document.getElementById('weight-input').value);
      if (!isFinite(val) || val < 20 || val > 300) return;
      const d = loadData();
      getOrCreateEntry(d, selectedDateKey).weight = val;
      if (selectedDateKey === getTodayKey()) d.profile.weight = val;
      saveData(d);
      const noteEl = document.getElementById('weight-saved-note');
      noteEl.classList.remove('hidden');
      setTimeout(() => noteEl.classList.add('hidden'), 2000);
      renderWeightProgress();
    });

    // Save steps
    document.getElementById('save-steps-btn').addEventListener('click', () => {
      const raw = stepsInput.value.trim();
      const steps = Math.round(Number(raw));
      const errEl = document.getElementById('steps-error');

      if (raw === '' || isNaN(steps) || steps < 0) {
        errEl.textContent = 'Please enter a valid number of steps (0 or more).';
        errEl.classList.remove('hidden');
        return;
      }
      errEl.classList.add('hidden');

      const d = loadData();
      const e = getOrCreateEntry(d, selectedDateKey);
      e.steps = steps;
      saveData(d);
      renderTodaySummary();
    });

    // NLP food input
    const nlpInput = document.getElementById('food-nlp-input');
    document.getElementById('log-food-btn').addEventListener('click', () => {
      parseNaturalLanguageFood(nlpInput.value.trim());
    });
    nlpInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        parseNaturalLanguageFood(nlpInput.value.trim());
      }
    });
    document.getElementById('confirm-foods-btn').addEventListener('click', confirmParsedFoods);
  }

  // ─── Natural Language Parsing ─────────────────────────────────────────────────

  function containsHebrew(text) {
    return [...text].some(c => { const n = c.charCodeAt(0); return n >= 0x0590 && n <= 0x05FF; });
  }

  async function translateHebrewToEnglish(text) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=he|en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Translation failed');
    const json = await res.json();
    const translated = json.responseData && json.responseData.translatedText;
    if (!translated || json.responseStatus !== 200 || translated.startsWith('MYMEMORY WARNING')) {
      throw new Error('Translation unavailable');
    }
    return translated;
  }

  async function parseNaturalLanguageFood(text) {
    if (!text) return;

    const data   = loadData();
    const apiKey = (data.profile.calorieNinjasKey || '').trim();

    const statusEl = document.getElementById('nlp-status');
    const logBtn   = document.getElementById('log-food-btn');

    if (!apiKey) {
      statusEl.textContent = 'Add your CalorieNinjas API key in the Profile tab to enable natural language logging.';
      statusEl.classList.remove('hidden');
      return;
    }

    statusEl.textContent = 'Parsing…';
    statusEl.classList.remove('hidden');
    logBtn.disabled = true;

    if (containsHebrew(text)) {
      try {
        statusEl.textContent = 'Translating…';
        text = await translateHebrewToEnglish(text);
      } catch (_) {
        statusEl.textContent = 'Could not translate Hebrew. Please try again.';
        logBtn.disabled = false;
        return;
      }
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 8000);

    try {
      const url      = `${CALORIE_NINJAS_URL}?query=${encodeURIComponent(text)}`;
      const response = await fetch(url, {
        headers: { 'X-Api-Key': apiKey },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        statusEl.textContent = response.status === 401
          ? 'Invalid API key. Check your Profile settings.'
          : `API error (HTTP ${response.status}). Try again.`;
        return;
      }

      const json  = await response.json();
      const items = json.items || [];

      if (items.length === 0) {
        statusEl.textContent = 'No food items recognized. Try rephrasing.';
        return;
      }

      statusEl.classList.add('hidden');
      pendingMeal  = getMealDefault();
      pendingQuery = document.getElementById('food-nlp-input').value.trim();

      // Auto-detect quantity from a leading number in the query (e.g. "2 eggs" → qty 2)
      // Only for single-item results to avoid ambiguity; cap at 20 so "100g chicken" stays qty 1
      const autoQtyMatch = items.length === 1 && pendingQuery.match(/^(\d+\.?\d*)\s/);
      const autoQty      = autoQtyMatch ? Math.min(20, parseFloat(autoQtyMatch[1])) : 1;

      pendingFoods = items.map(f => {
        const qty      = autoQty > 1 ? autoQty : 1;
        const calories = Math.round((f.calories || 0) / qty);
        const protein  = Math.round(((f.protein_g || 0) / qty) * 10) / 10;
        const carbs    = Math.round(((f.carbohydrates_total_g || 0) / qty) * 10) / 10;
        const fat      = Math.round(((f.fat_total_g || 0) / qty) * 10) / 10;
        return {
          name:     capitalize(f.name),
          calories,
          protein,
          carbs,
          fat,
          serving:  `${Math.round(f.serving_size_g)}g`,
          quantity: qty,
        };
      });
      renderPendingList();

    } catch (err) {
      clearTimeout(timeoutId);
      statusEl.textContent = err.name === 'AbortError'
        ? 'Request timed out. Try again.'
        : 'Network error. Please check your connection.';
    } finally {
      logBtn.disabled = false;
    }
  }

  function renderPendingList() {
    const list = document.getElementById('parsed-results');
    const wrap = document.getElementById('parsed-results-wrap');
    list.innerHTML = '';

    if (pendingFoods.length === 0) {
      wrap.classList.add('hidden');
      return;
    }

    pendingFoods.forEach((food, idx) => {
      const baseCalories = food.calories || 0;
      const baseProtein  = food.protein  || 0;
      const baseCarbs    = food.carbs    || 0;
      const baseFat      = food.fat      || 0;
      const initialQty   = food.quantity || 1;

      const li = document.createElement('li');
      li.className = 'parsed-item';
      li.dataset.protein = Math.round(baseProtein * initialQty * 10) / 10;
      li.dataset.carbs   = Math.round(baseCarbs   * initialQty * 10) / 10;
      li.dataset.fat     = Math.round(baseFat     * initialQty * 10) / 10;

      const qtyInput = document.createElement('input');
      qtyInput.type      = 'number';
      qtyInput.className = 'parsed-qty-input';
      qtyInput.value     = food.quantity || 1;
      qtyInput.min       = '0.5';
      qtyInput.step      = '0.5';
      qtyInput.setAttribute('aria-label', 'Quantity');

      const qtyX = document.createElement('span');
      qtyX.className   = 'parsed-kcal-unit';
      qtyX.textContent = '×';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'parsed-name-input';
      nameInput.value = food.name;
      nameInput.setAttribute('aria-label', 'Food name');

      const servingSpan = document.createElement('span');
      servingSpan.className = 'parsed-serving';
      servingSpan.textContent = food.serving;

      const kcalInput = document.createElement('input');
      kcalInput.type = 'number';
      kcalInput.className = 'parsed-kcal-input';
      kcalInput.value = Math.round(baseCalories * initialQty);
      kcalInput.min = '0';
      kcalInput.setAttribute('aria-label', 'Calories');

      const kcalUnit = document.createElement('span');
      kcalUnit.className = 'parsed-kcal-unit';
      kcalUnit.textContent = 'kcal';

      qtyInput.addEventListener('input', () => {
        const qty = Math.max(0.5, parseFloat(qtyInput.value) || 1);
        kcalInput.value    = Math.round(baseCalories * qty);
        li.dataset.protein = Math.round(baseProtein  * qty * 10) / 10;
        li.dataset.carbs   = Math.round(baseCarbs    * qty * 10) / 10;
        li.dataset.fat     = Math.round(baseFat      * qty * 10) / 10;
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-food-btn';
      removeBtn.textContent = '✕';
      removeBtn.setAttribute('aria-label', `Remove ${food.name}`);
      removeBtn.addEventListener('click', () => {
        pendingFoods.splice(idx, 1);
        renderPendingList();
      });

      li.appendChild(qtyInput);
      li.appendChild(qtyX);
      li.appendChild(nameInput);
      li.appendChild(servingSpan);
      li.appendChild(kcalInput);
      li.appendChild(kcalUnit);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });

    // Meal selector
    const selectorEl = document.getElementById('meal-selector');
    selectorEl.querySelectorAll('.meal-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.meal === pendingMeal);
      btn.onclick = () => {
        pendingMeal = btn.dataset.meal;
        selectorEl.querySelectorAll('.meal-btn').forEach(b => b.classList.toggle('active', b === btn));
      };
    });

    // Combine button — only show when there are multiple items
    const combineBtn = document.getElementById('combine-dish-btn');
    if (pendingFoods.length > 1) {
      combineBtn.classList.remove('hidden');
      combineBtn.onclick = () => {
        const totals = pendingFoods.reduce(
          (acc, f) => ({ calories: acc.calories + f.calories, protein: acc.protein + f.protein, carbs: acc.carbs + f.carbs, fat: acc.fat + f.fat }),
          { calories: 0, protein: 0, carbs: 0, fat: 0 }
        );
        pendingFoods = [{
          name:     pendingQuery || 'Combined dish',
          calories: Math.round(totals.calories),
          protein:  Math.round(totals.protein * 10) / 10,
          carbs:    Math.round(totals.carbs   * 10) / 10,
          fat:      Math.round(totals.fat     * 10) / 10,
          serving:  '',
        }];
        renderPendingList();
      };
    } else {
      combineBtn.classList.add('hidden');
    }

    wrap.classList.remove('hidden');
  }

  function confirmParsedFoods() {
    const listEl = document.getElementById('parsed-results');
    const items  = listEl.querySelectorAll('.parsed-item');
    if (items.length === 0) return;

    const data    = loadData();
    const dateKey = selectedDateKey;
    const entry   = getOrCreateEntry(data, dateKey);

    items.forEach(item => {
      const name     = item.querySelector('.parsed-name-input').value.trim();
      const calories = Math.max(0, Math.round(Number(item.querySelector('.parsed-kcal-input').value) || 0));
      const protein  = Number(item.dataset.protein) || 0;
      const carbs    = Number(item.dataset.carbs)   || 0;
      const fat      = Number(item.dataset.fat)     || 0;
      const quantity = Math.max(0.5, parseFloat(item.querySelector('.parsed-qty-input').value) || 1);
      if (name) entry.foods.push({ name, calories, protein, carbs, fat, meal: pendingMeal, quantity });
    });

    saveData(data);

    pendingFoods = [];
    document.getElementById('parsed-results-wrap').classList.add('hidden');
    document.getElementById('food-nlp-input').value = '';
    renderFoodLog();
    renderTodaySummary();
    renderRecentFoods();
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  // ─── Recent Foods ─────────────────────────────────────────────────────────────

  function getRecentFoods(data, limit = 6) {
    const seen   = new Set();
    const result = [];
    const keys   = Object.keys(data.entries).sort().reverse();
    for (const key of keys) {
      const foods = (data.entries[key].foods || []).slice().reverse();
      for (const f of foods) {
        if (!seen.has(f.name)) {
          seen.add(f.name);
          result.push(f);
          if (result.length >= limit) return result;
        }
      }
    }
    return result;
  }

  function renderRecentFoods() {
    const data    = loadData();
    const recents = getRecentFoods(data);
    const wrap    = document.getElementById('recent-foods-wrap');
    const list    = document.getElementById('recent-foods-list');
    list.innerHTML = '';
    if (recents.length === 0) { wrap.classList.add('hidden'); return; }

    recents.forEach(food => {
      const pill       = document.createElement('button');
      pill.type        = 'button';
      pill.className   = 'recent-food-pill';
      pill.textContent = `${food.name} · ${food.calories} kcal`;
      pill.addEventListener('click', () => {
        pendingFoods = [{ name: food.name, calories: food.calories, protein: food.protein, carbs: food.carbs, fat: food.fat, serving: '' }];
        pendingMeal  = getMealDefault();
        pendingQuery = food.name;
        renderPendingList();
      });
      list.appendChild(pill);
    });
    wrap.classList.remove('hidden');
  }

  // ─── Profile Tab ─────────────────────────────────────────────────────────────

  function initProfileTab() {
    const data = loadData();
    const p    = data.profile;
    document.getElementById('profile-name').value             = p.name            || '';
    document.getElementById('profile-weight').value           = p.weight;
    document.getElementById('profile-height').value           = p.height;
    document.getElementById('profile-age').value              = p.age;
    document.getElementById('profile-gender').value           = p.gender;
    document.getElementById('profile-step-goal').value        = p.stepGoal        || 10000;
    document.getElementById('profile-deficit-goal').value     = p.deficitGoal     || 500;
    document.getElementById('profile-calorie-ninjas-key').value = p.calorieNinjasKey || '';
    document.getElementById('profile-weight-goal').value        = p.weightGoal > 0 ? p.weightGoal : '';

    document.getElementById('export-btn').addEventListener('click', exportData);
    document.getElementById('import-input').addEventListener('change', e => {
      if (e.target.files[0]) importData(e.target.files[0]);
    });
  }

  function exportData() {
    const json = localStorage.getItem(STORAGE_KEY) || '{}';
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `calorie-data-${getTodayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    const statusEl = document.getElementById('import-status');
    const reader   = new FileReader();
    reader.onload  = e => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed.profile || !parsed.entries) throw new Error('Invalid');
        if (!confirm('This will replace all your current data. Are you sure?')) return;
        saveData(parsed);
        statusEl.textContent = 'Data imported! Refresh the page to apply.';
        statusEl.classList.remove('hidden');
      } catch {
        statusEl.textContent = 'Invalid file — please use a previously exported file.';
        statusEl.classList.remove('hidden');
      }
    };
    reader.readAsText(file);
  }

  function saveProfile() {
    const name        = document.getElementById('profile-name').value.trim();
    const weight      = parseFloat(document.getElementById('profile-weight').value);
    const height      = parseFloat(document.getElementById('profile-height').value);
    const age         = parseInt(document.getElementById('profile-age').value, 10);
    const gender      = document.getElementById('profile-gender').value;
    const stepGoal       = parseInt(document.getElementById('profile-step-goal').value, 10);
    const deficitGoal    = parseInt(document.getElementById('profile-deficit-goal').value, 10);
    const calorieNinjasKey = document.getElementById('profile-calorie-ninjas-key').value.trim();
    const weightGoal       = parseFloat(document.getElementById('profile-weight-goal').value) || 0;

    if (!isFinite(weight) || weight <= 0 ||
        !isFinite(height) || height <= 0 ||
        !isFinite(age)    || age <= 0    ||
        !isFinite(stepGoal) || stepGoal <= 0 ||
        !isFinite(deficitGoal) || deficitGoal <= 0) {
      return;
    }

    const data = loadData();
    data.profile = { name, weight, height, age, gender, stepGoal, deficitGoal, weightGoal, calorieNinjasKey };
    saveData(data);

    const msg = document.getElementById('profile-saved-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2000);

    renderGreeting();
    renderTodaySummary();
  }

  // ─── Chart Utils ─────────────────────────────────────────────────────────────

  function getPastDays(n) {
    const keys = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      keys.push(d.toISOString().slice(0, 10));
    }
    return keys;
  }

  function buildChartData(dateKeys, data) {
    const labels = dateKeys.map(key => {
      const d = new Date(key + 'T00:00:00');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const values = dateKeys.map(key => {
      const def = calcDayDeficit(data, key);
      return def !== null ? Math.round(def) : 0;
    });
    return { labels, values };
  }

  function renderChart(canvasId, labels, values) {
    if (chartInstances[canvasId]) {
      chartInstances[canvasId].destroy();
    }
    const ctx = document.getElementById(canvasId).getContext('2d');
    chartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Calorie Deficit (kcal)',
          data: values,
          backgroundColor: values.map(v => v >= 0 ? '#4caf50' : '#f44336'),
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.parsed.y.toLocaleString()} kcal`
            }
          }
        },
        scales: {
          y: {
            title: { display: true, text: 'Deficit (kcal)' },
            ticks: {
              callback: v => v.toLocaleString()
            }
          }
        }
      }
    });
  }

  function renderWeightChart(canvasId, dateKeys, data) {
    const noteId = canvasId === 'weekly-weight-chart' ? 'weekly-weight-note' : 'monthly-weight-note';
    const noteEl = document.getElementById(noteId);

    const weights = dateKeys.map(k => {
      const w = data.entries[k] && data.entries[k].weight;
      return (w && w > 0) ? w : null;
    });

    const valid = weights.filter(w => w !== null);
    if (valid.length === 0) {
      noteEl.textContent = 'No weight logged yet — log your weight in the Today tab.';
      if (chartInstances[canvasId]) { chartInstances[canvasId].destroy(); delete chartInstances[canvasId]; }
      return;
    }

    const minW   = Math.min(...valid);
    const maxW   = Math.max(...valid);
    const first  = valid[0];
    const last   = valid[valid.length - 1];
    const change = +(last - first).toFixed(1);
    noteEl.textContent = change === 0
      ? 'Weight stable over this period.'
      : change < 0
        ? `Lost ${Math.abs(change)} kg over this period. 💪`
        : `Gained ${change} kg over this period.`;

    const labels = dateKeys.map(key => {
      const d = new Date(key + 'T00:00:00');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Weight (kg)',
          data: weights,
          borderColor: '#c4607a',
          backgroundColor: 'rgba(196,96,122,0.08)',
          pointBackgroundColor: weights.map(w => w !== null ? '#c4607a' : 'transparent'),
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2.5,
          fill: true,
          spanGaps: true,
          tension: 0.35,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => c.parsed.y !== null ? `${c.parsed.y} kg` : '' } }
        },
        scales: {
          y: {
            title: { display: true, text: 'Weight (kg)' },
            min: Math.max(0, minW - 2),
            max: maxW + 2,
            ticks: { callback: v => `${v} kg` }
          }
        }
      }
    });
  }

  function findBestDay(data) {
    let best = null;
    Object.entries(data.entries).forEach(([key, entry]) => {
      const d = calcDayDeficit(data, key);
      if (d !== null && (best === null || d > best.deficit)) {
        best = { key, deficit: Math.round(d), steps: entry.steps || 0 };
      }
    });
    return best;
  }

  function renderBestDay(data) {
    const textEl = document.getElementById('best-day-text');
    const best   = findBestDay(data);
    if (!best) {
      textEl.innerHTML = 'Keep logging — your best day is yet to come!';
      return;
    }
    const date    = new Date(best.key + 'T00:00:00');
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    textEl.innerHTML =
      `🏆 <strong>${dateStr}</strong> — <strong>${best.deficit.toLocaleString()} kcal</strong> deficit` +
      (best.steps > 0 ? ` with <strong>${best.steps.toLocaleString()}</strong> steps` : '');
  }

  function calcProjection(data) {
    const keys     = getPastDays(14);
    const deficits = keys.map(k => calcDayDeficit(data, k)).filter(d => d !== null && d > 0);
    if (deficits.length < 3) return null;
    const avg = Math.round(deficits.reduce((a, b) => a + b, 0) / deficits.length);
    if (avg <= 0) return null;
    const daysPerKg = Math.round(KCAL_PER_KG / avg);
    const goal = Number(data.profile.weightGoal) || 0;
    const recentWeight = [...getPastDays(30)].reverse()
      .map(k => data.entries[k] && data.entries[k].weight).find(w => w > 0) || null;
    const kgToGoal    = (goal > 0 && recentWeight && recentWeight > goal)
      ? +(recentWeight - goal).toFixed(1) : null;
    const daysToGoal  = kgToGoal ? Math.round(kgToGoal * daysPerKg) : null;
    const weeksToGoal = daysToGoal ? Math.round(daysToGoal / 7) : null;
    return { avg, daysPerKg, kgToGoal, daysToGoal, weeksToGoal, recentWeight, goal };
  }

  function renderProjection(data) {
    const textEl = document.getElementById('projection-text');
    const proj   = calcProjection(data);
    if (!proj) {
      textEl.innerHTML = 'Log at least 3 days of deficit data to see your projection.';
      return;
    }
    let html = `Your 14-day average deficit is <strong>${proj.avg.toLocaleString()} kcal/day</strong> — that's roughly 1 kg every <strong>${proj.daysPerKg} days</strong>.`;
    if (proj.kgToGoal && proj.weeksToGoal) {
      html += `<br><br>At this rate, you'll reach <strong>${proj.goal} kg</strong> in about <strong>${proj.weeksToGoal} week${proj.weeksToGoal !== 1 ? 's' : ''}</strong> 💪`;
    } else if (proj.goal > 0 && proj.recentWeight && proj.recentWeight <= proj.goal) {
      html += `<br><br>You've already reached your goal weight of <strong>${proj.goal} kg</strong> — amazing! 🎉`;
    }
    textEl.innerHTML = html;
  }

  function initWeeklyTab() {
    const data  = loadData();
    const keys  = getPastDays(7);
    const { labels, values } = buildChartData(keys, data);
    const total = values.reduce((a, b) => a + b, 0);

    document.getElementById('weekly-total').textContent =
      `7-day total deficit: ${total.toLocaleString()} kcal`;
    renderChart('weekly-chart', labels, values);
    renderWeightChart('weekly-weight-chart', keys, data);
    renderBestDay(data);
  }

  function initMonthlyTab() {
    const data  = loadData();
    const keys  = getPastDays(30);
    const { labels, values } = buildChartData(keys, data);
    const total = values.reduce((a, b) => a + b, 0);

    document.getElementById('monthly-total').textContent =
      `30-day total deficit: ${total.toLocaleString()} kcal`;
    renderChart('monthly-chart', labels, values);
    renderWeightChart('monthly-weight-chart', keys, data);
    renderProjection(data);
  }

  // ─── Tab Navigation ───────────────────────────────────────────────────────────

  function initTabs() {
    const buttons  = document.querySelectorAll('.tab-btn');
    const sections = document.querySelectorAll('.tab-section');

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;

        buttons.forEach(b  => b.classList.remove('active'));
        sections.forEach(s => s.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(`tab-${tab}`).classList.add('active');

        if (tab === 'weekly')  initWeeklyTab();
        if (tab === 'monthly') initMonthlyTab();
        if (tab === 'profile') initProfileTab();
      });
    });
  }

  // ─── Storage banner ───────────────────────────────────────────────────────────

  function showBanner(msg) {
    let banner = document.getElementById('storage-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'storage-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#c62828;color:#fff;text-align:center;padding:0.5rem;font-size:0.85rem;z-index:999';
      document.body.prepend(banner);
    }
    banner.textContent = msg;
  }

  // ─── Entry Point ──────────────────────────────────────────────────────────────

  function init() {
    initFirebase();

    // Seed localStorage on first run — write directly so we don't push empty data to Firestore
    if (!localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(freshData()));
    }

    initTabs();
    initTodayTab();

    // Profile form submit
    document.getElementById('profile-form').addEventListener('submit', e => {
      e.preventDefault();
      saveProfile();
    });

    cloudLoad(); // async — silently updates UI if cloud has newer data
  }

  document.addEventListener('DOMContentLoaded', init);
})();
