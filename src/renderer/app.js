// ── State ──
let lang = 'zh';
let selectedBuddy = null;
let detectedBinaryPath = null;
let worker = null;
let pool = [];
let rendered = 0;
let previewInterval = null;
let selectedCardSprite = null;
let selectedCardElement = null;
let searchActive = false;
let searchStartedAt = 0;
let lastSearchProgress = null;
let lastSearchCompleted = false;
let longSearchPromptTimer = null;
let searchStage = 'idle';
let scanCompletedCount = 0;
let completedMetricsHistory = '';
let debugPanelOpen = false;
let patchingActive = false;
let patchingTimer = null;
let patchingFrame = 0;
const debugState = {
  hashEngine: 'unknown',
  searchEngine: 'unknown',
  bunAvailable: 'unknown',
  claudeBinary: 'unknown',
  platform: 'unknown',
  bunPath: 'unknown',
};
const hashSeedCache = new Map();
const HASH_CACHE_MAX = 1024;
const RENDER_BATCH_SIZE = 50;
const PATCHING_FRAMES = ['', '.', '..', '...'];
const REQUIRED_UUID_LENGTH = 36;
const REQUIRED_SALT_LENGTH = 15;

// Stat field config for DOM updates in selectBuddy / renderBatch
const STAT_FIELDS = [
  { statId: 's-deb', barId: 'bar-deb', key: 'd', i18nKey: 'debugging', colorClass: 'bg-primary' },
  { statId: 's-pat', barId: 'bar-pat', key: 'p', i18nKey: 'patience',  colorClass: 'bg-primary' },
  { statId: 's-cha', barId: 'bar-cha', key: 'c', i18nKey: 'chaos',     colorClass: 'bg-secondary' },
  { statId: 's-wis', barId: 'bar-wis', key: 'w', i18nKey: 'wisdom',    colorClass: 'bg-tertiary' },
  { statId: 's-snk', barId: 'bar-snk', key: 's', i18nKey: 'snark',     colorClass: 'bg-gradient-to-r from-secondary to-secondary-container' },
];
const STAT_SLIDER_IDS = ['debugging', 'patience', 'chaos', 'wisdom', 'snark'];

// ── i18n ──
function clearPatchingTimer() {
  if (patchingTimer) {
    clearInterval(patchingTimer);
    patchingTimer = null;
  }
}

function updatePatchingLabel() {
  if (!patchingActive) return;
  const labelEl = document.querySelector('#btn-patch-now [data-i18n="btn_patch_now"]');
  if (!labelEl) return;
  const baseLabel = I18N[lang].btn_patching_now;
  const suffix = PATCHING_FRAMES[patchingFrame % PATCHING_FRAMES.length];
  labelEl.textContent = `${baseLabel}${suffix}`;
  patchingFrame += 1;
}

function setPatchBusyState(isBusy) {
  const patchBtn = document.getElementById('btn-patch-now');
  const patchIcon = document.getElementById('patch-icon');
  const patchStatus = document.getElementById('patch-status');
  const patchStatusText = document.getElementById('patch-status-text');
  const patchLabel = patchBtn?.querySelector('[data-i18n="btn_patch_now"]');

  patchingActive = isBusy;

  if (!patchBtn || !patchLabel) return;

  patchBtn.disabled = isBusy;
  patchBtn.setAttribute('aria-busy', String(isBusy));
  patchBtn.classList.toggle('patching', isBusy);
  if (patchIcon) patchIcon.classList.toggle('spinning', isBusy);
  setHidden(patchStatus, !isBusy);

  if (patchStatusText) patchStatusText.textContent = I18N[lang].patch_status_working;

  if (isBusy) {
    patchingFrame = 0;
    updatePatchingLabel();
    clearPatchingTimer();
    patchingTimer = setInterval(updatePatchingLabel, 280);
    return;
  }

  clearPatchingTimer();
  patchLabel.textContent = I18N[lang].btn_patch_now;
}

function updateIdentityValidationUi() {
  const uuidValue = userIdInput.value.trim();
  const saltValue = saltInput.value.trim();
  const uuidInvalid = uuidValue.length > 0 && uuidValue.length !== REQUIRED_UUID_LENGTH;
  const saltInvalid = saltValue.length > 0 && saltValue.length !== REQUIRED_SALT_LENGTH;

  const uuidShell = document.getElementById('userId-shell');
  const saltShell = document.getElementById('salt-shell');
  const uuidHint = document.getElementById('userId-hint');
  const saltHint = document.getElementById('salt-hint');

  uuidShell?.classList.toggle('invalid', uuidInvalid);
  saltShell?.classList.toggle('invalid', saltInvalid);
  setHidden(uuidHint, !uuidInvalid);
  setHidden(saltHint, !saltInvalid);

  return {
    isUuidStrictValid: uuidValue.length === REQUIRED_UUID_LENGTH,
    isSaltStrictValid: saltValue.length === REQUIRED_SALT_LENGTH,
  };
}

function setLang(languageCode) {
  if (!I18N[languageCode]) return;

  lang = languageCode;
  const strings = I18N[languageCode];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (strings[key] !== undefined) el.textContent = strings[key];
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.dataset.i18nAriaLabel;
    if (strings[key] !== undefined) el.setAttribute('aria-label', strings[key]);
  });
  const toggle = document.getElementById('lang-toggle');
  if (toggle) toggle.textContent = strings.toggle_label;
  setupFilters();
  refreshSearchUiText();
  rerenderVisibleCards();
  renderDebugPanel();
  updateIdentityValidationUi();
  if (patchingActive) {
    const patchStatusText = document.getElementById('patch-status-text');
    if (patchStatusText) patchStatusText.textContent = I18N[lang].patch_status_working;
    patchingFrame = 0;
    updatePatchingLabel();
  }
}

document.getElementById('lang-toggle').addEventListener('click', () => {
  setLang(lang === 'en' ? 'zh' : 'en');
  updateBinaryStatus();
});

const RARITY_LIMITS = {
  common: 84,
  uncommon: 94,
  rare: 100,
  epic: 100,
  legendary: 100
};

const RARITY_MIN_LIMITS = {
  common: 1,
  uncommon: 5,
  rare: 15,
  epic: 25,
  legendary: 40
};

const RARITY_DUMP_MAX = {
  common: 9,
  uncommon: 19,
  rare: 29,
  epic: 39,
  legendary: 54
};

const RARITY_THEORETICAL_MAX = {
  common: 225,
  uncommon: 275,
  rare: 321,
  epic: 361,
  legendary: 421
};
const ALL_RARITY_DUMP_MAX = Math.max(...Object.values(RARITY_DUMP_MAX));
const ALL_RARITY_THEORETICAL_MAX = Math.max(...Object.values(RARITY_THEORETICAL_MAX));

let dynamicTotalAttempts = 5000000;
const SEARCH_TARGET_COUNT = 360;

// ── Probability & Difficulty ──
function calculateTotalProbability() {
  const f = collectFilters();
  const rarity = f.rarity || '';
  
  // 1. Rarity Prob
  let p = 1.0;
  if (rarity) {
    p *= (RARITY_WEIGHTS[rarity] / 100);
  }
  
  // 2. Category Prob
  if (f.species) p *= (1 / 18);
  if (f.eye)     p *= (1 / 6);
  if (f.hat && (rarity !== 'common')) p *= (1 / 8);
  if (f.shiny)   p *= 0.01;
  
  // 3. Stats Prob (Heuristic)
  // When rarity is 'all', use 'legendary' floor to estimate if the stat is at least theoretically possible
  const floor = RARITY_FLOOR[rarity || 'legendary'];
  const statFilters = [f.d, f.p, f.c, f.w, f.s];
  
  for (const threshold of statFilters) {
    if (threshold <= floor) continue;
    
    // Approximation: 1/5 Peak, 1/5 Dump, 3/5 Normal
    let pPeak = Math.max(0, Math.min(1, (floor + 80 - threshold) / 30));
    let pDump = Math.max(0, Math.min(1, (floor + 5 - threshold) / 15));
    let pNormal = Math.max(0, Math.min(1, (floor + 40 - threshold) / 40));
    
    const pStat = (0.2 * pPeak) + (0.2 * pDump) + (0.6 * pNormal);
    p *= pStat;
  }
  
  return p;
}

function validateSearchPossibility() {
  const raritySelect = document.getElementById('f-rarity');
  const rarity = raritySelect.value;
  const filters = collectFilters();
  const statValues = [filters.d, filters.p, filters.c, filters.w, filters.s];
  const totalSum = statValues.reduce((a, b) => a + b, 0);
  
  const floor = rarity ? RARITY_FLOOR[rarity] : RARITY_FLOOR.legendary;
  const normalMax = floor + 39;
  const dumpMax = rarity ? RARITY_DUMP_MAX[rarity] : ALL_RARITY_DUMP_MAX;
  const theoreticalMax = rarity ? RARITY_THEORETICAL_MAX[rarity] : ALL_RARITY_THEORETICAL_MAX;
  
  const allAboveDump = statValues.every(v => v > dumpMax);
  const isTooHigh = totalSum > theoreticalMax;
  const peakCount = statValues.filter(v => v > normalMax).length;
  
  const searchBtn = document.getElementById('search-btn');
  const metricsEl = document.getElementById('search-metrics');
  const userId = document.getElementById('userId').value.trim();
  const strings = I18N[lang];
  
  if (!searchActive) {
    if (allAboveDump || isTooHigh || peakCount > 1) {
      searchBtn.disabled = true;
      let errorMsg = strings.btn_search_err_dump;
      if (isTooHigh) errorMsg = strings.btn_search_err_total;
      else if (peakCount > 1) errorMsg = strings.btn_search_err_peak;
      
      setSearchButtonMessage(errorMsg);
      metricsEl.textContent = '';
      metricsEl.classList.remove('text-error');
    } else {
      searchBtn.disabled = !userId;
      setSearchButtonMessage();
      metricsEl.classList.remove('text-error');
      
      const prob = calculateTotalProbability();
      if (prob <= 0) {
        searchBtn.disabled = true;
        setSearchButtonMessage(strings.btn_search_err_total);
        metricsEl.textContent = '';
        metricsEl.classList.remove('text-error');
      } else {
        // Target is fixed at 360 buddies; search until target is reached or user stops.
        const targetCount = SEARCH_TARGET_COUNT;
        dynamicTotalAttempts = null; // No limit
        
        metricsEl.textContent = ''; // Removed estimation text
      }
    }
  }
}

// ── Setup Filters ──
function updateStatLimits() {
  const raritySelect = document.getElementById('f-rarity');
  const rarity = raritySelect.value;
  const floor = rarity ? RARITY_FLOOR[rarity] : RARITY_FLOOR.legendary;
  const normalMax = floor + 39;
  const peakMax = rarity ? (RARITY_LIMITS[rarity] || 100) : 100;
  const minLimit = rarity ? (RARITY_MIN_LIMITS[rarity] || 0) : 0;
  
  // 找出目前是否有屬性已經超過了「一般屬性」的上限
  let currentPeakId = null;
  STAT_SLIDER_IDS.forEach(id => {
    const slider = document.getElementById(`f-${id}`);
    if (slider && parseInt(slider.value) > normalMax) {
      currentPeakId = id;
    }
  });

  STAT_SLIDER_IDS.forEach(id => {
    const slider = document.getElementById(`f-${id}`);
    const display = document.getElementById(`v-${id}`);
    if (slider) {
      // 如果已經有其他屬性是「高峰」，則本屬性上限被限制在「一般上限」
      const effectiveMax = (currentPeakId && currentPeakId !== id) ? normalMax : peakMax;
      
      slider.max = effectiveMax;
      slider.min = minLimit;
      
      if (parseInt(slider.value) > effectiveMax) {
        slider.value = effectiveMax;
      } else if (parseInt(slider.value) < minLimit) {
        slider.value = minLimit;
      }
      
      if (display) display.textContent = slider.value;
    }
  });

  const hatSelect = document.getElementById('f-hat');
  if (hatSelect) {
    // 只有明確選擇 'common' 時才停用帽子，'all' (空值) 應該可以選
    if (raritySelect.value === 'common') {
      hatSelect.value = '';
      hatSelect.disabled = true;
      hatSelect.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
      hatSelect.disabled = false;
      hatSelect.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }
  
  validateSearchPossibility();
}

function resetFilters() {
  document.getElementById('f-species').value = '';
  document.getElementById('f-rarity').value = '';
  document.getElementById('f-eyes').value = '';
  document.getElementById('f-hat').value = '';
  document.getElementById('f-shiny').checked = false;
  
  STAT_SLIDER_IDS.forEach(id => {
    const slider = document.getElementById(`f-${id}`);
    if (slider) slider.value = 0;
  });
  
  updateStatLimits();
  showToast(I18N[lang].toast_filters_reset || 'Filters reset', 'ok');
}

document.getElementById('reset-filters-btn').addEventListener('click', resetFilters);

function setupFilters() {
  const strings = I18N[lang];
  const resetSelectOptions = (id, options, formatter) => {
    const selectElement = document.getElementById(id);
    if (!selectElement) return;
    const firstOption = selectElement.firstElementChild;
    selectElement.innerHTML = '';
    if (firstOption) selectElement.appendChild(firstOption);

    options.forEach(optionValue => {
      const optionElement = document.createElement('option');
      optionElement.value = optionValue;
      optionElement.textContent = formatter ? formatter(optionValue) : optionValue;
      selectElement.appendChild(optionElement);
    });
  };

  const hatStyles = {
    none: '', crown: '\\^^^/', tophat: '[___]', propeller: '-+-',
    halo: '(   )', wizard: '/^\\', beanie: '(___)', tinyduck: ',>'
  };

  resetSelectOptions('f-species', SPECIES, (value) => {
    const localizedName = strings.names[value] || value;
    return lang === 'zh' ? `${localizedName} (${value})` : value;
  });
  resetSelectOptions('f-rarity', RARITIES, (value) => {
    const rarityName = lang === 'zh' ? (strings.rarities[value] || value) : value;
    return `${rarityName} ${RARITY_STARS[value]}`;
  });
  resetSelectOptions('f-eyes', EYES);
  resetSelectOptions('f-hat', HATS, (value) => {
    const hatName = strings.names[value] || value;
    const hatStyle = hatStyles[value] || '';
    return hatStyle ? `${hatName} ${hatStyle}` : hatName;
  });

  const raritySelect = document.getElementById('f-rarity');
  if (raritySelect && !raritySelect.dataset.limitListenerSet) {
    raritySelect.addEventListener('change', updateStatLimits);
    raritySelect.dataset.limitListenerSet = 'true';
  }

  STAT_SLIDER_IDS.forEach(id => {
    const slider = document.getElementById(`f-${id}`);
    const display = document.getElementById(`v-${id}`);
    if (slider && display && !slider.dataset.listenerSet) {
      slider.addEventListener('input', () => { 
        display.textContent = slider.value; 
        updateStatLimits(); // 確保這裡調用的是 updateStatLimits 而非僅 validateSearchPossibility
      });
      slider.dataset.listenerSet = 'true';
    }
  });
  
  updateStatLimits();
}

// ── Validation ──
function validateUpdateBtn() {
  const userId = document.getElementById('userId').value.trim();
  const name = document.getElementById('buddy-name').value.trim();
  const personality = document.getElementById('buddy-pers').value.trim();
  const updateButton = document.getElementById('btn-update-info');
  if (updateButton) updateButton.disabled = !(userId && name && personality);
}

function collectFilters() {
  const parseStat = (id) => {
    const parsed = Number.parseInt(document.getElementById(id).value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    species: document.getElementById('f-species').value,
    rarity:  document.getElementById('f-rarity').value,
    eye:     document.getElementById('f-eyes').value,
    hat:     document.getElementById('f-hat').value,
    shiny:   document.getElementById('f-shiny').checked,
    d: parseStat('f-debugging'),
    p: parseStat('f-patience'),
    c: parseStat('f-chaos'),
    w: parseStat('f-wisdom'),
    s: parseStat('f-snark'),
  };
}

// ── Formatters ──
function formatCompact(n) {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-TW' : 'en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return '--';
  if (rate >= 1000000) return `${(rate / 1000000).toFixed(2)}M/s`;
  if (rate >= 1000)    return `${(rate / 1000).toFixed(1)}k/s`;
  return `${Math.round(rate)}/s`;
}

function formatProbability(probability) {
  if (!Number.isFinite(probability) || probability <= 0) return '1/∞';
  if (probability >= 1) return '1/1';
  const oneInN = Math.max(1, Math.round(1 / probability));
  return `1/${formatCompact(oneInN)}`;
}

// ── Search UI Updates ──
function setResultCount(stored, matches = null) {
  const resultCountEl = document.getElementById('result-count');
  if (!resultCountEl) return;
  const strings = I18N[lang];
  const safeStored = Number.isFinite(stored) ? stored : 0;

  if (searchActive) {
    if (searchStage === 'organizing') {
      resultCountEl.textContent = `${strings.result_organizing} ${formatCompact(safeStored)}/${SEARCH_TARGET_COUNT}`;
    } else {
      resultCountEl.textContent = `${strings.result_found} ${formatCompact(safeStored)}`;
    }
    return;
  }
  resultCountEl.textContent = `${formatCompact(safeStored)} ${strings.result_matches}`;
}

function setSearchMetrics(text) {
  const el = document.getElementById('search-metrics');
  if (el) el.textContent = text;
}

function updateSearchStageMetrics() {
  if (!searchActive) return;
  const strings = I18N[lang];
  const done = Number.isFinite(Number(lastSearchProgress?.done)) ? Number(lastSearchProgress.done) : 0;
  const elapsed = Math.max(0.001, (Date.now() - searchStartedAt) / 1000);
  const rate = done / elapsed;

  if (searchStage === 'scanning') {
    const scanningText = `[ ] ${strings.search_metric_scanning_prefix} ${formatCompact(done)} · ${strings.search_metric_rate} ${formatRate(rate)}`;
    setSearchMetrics(scanningText);
    return;
  }

  if (searchStage === 'organizing') {
    const organizingText = `[V] ${strings.search_metric_scanning_prefix} ${formatCompact(scanCompletedCount)} ${strings.search_metric_complete}\n[ ] ${strings.search_metric_organizing_prefix} ${formatCompact(pool.length)}/${SEARCH_TARGET_COUNT}`;
    setSearchMetrics(organizingText);
  }
}

function setSearchButtonMessage(message = null) {
  const button = document.getElementById('search-btn');
  const msgArea = document.getElementById('search-restriction-msg');
  if (!button || !msgArea) return;
  const strings = I18N[lang];
  const isWarning = Boolean(message);

  button.textContent = strings.btn_search;
  msgArea.textContent = message || '';
  
  button.classList.toggle('text-error', isWarning);
  button.classList.toggle('border-error', isWarning);
  button.classList.toggle('hover:bg-error/10', isWarning);
  button.classList.toggle('text-primary', !isWarning);
  button.classList.toggle('border-primary/60', !isWarning);
  button.classList.toggle('hover:bg-primary/10', !isWarning);
}

function setHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle('is-hidden', hidden);
}

function getDebugLabel(kind, value) {
  const strings = I18N[lang];
  const map = {
    hashEngine: {
      unknown: strings.debug_state_unknown,
      'not-used': strings.debug_state_not_used,
      bun: strings.debug_state_bun_hash,
      javascript: strings.debug_state_js_hash,
    },
    searchEngine: {
      unknown: strings.debug_state_unknown,
      'not-used': strings.debug_state_not_used,
      bun: strings.debug_state_bun_search,
      worker: strings.debug_state_worker_search,
    },
    availability: {
      unknown: strings.debug_state_unknown,
      yes: strings.debug_state_yes,
      no: strings.debug_state_no,
    },
    binary: {
      unknown: strings.debug_state_unknown,
      found: strings.debug_state_found,
      missing: strings.debug_state_missing,
    },
  };
  return map[kind]?.[value] ?? value ?? strings.debug_state_unknown;
}

function setDebugValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderDebugPanel() {
  setDebugValue('debug-hash-engine', getDebugLabel('hashEngine', debugState.hashEngine));
  setDebugValue('debug-search-engine', getDebugLabel('searchEngine', debugState.searchEngine));
  setDebugValue('debug-bun-available', getDebugLabel('availability', debugState.bunAvailable));
  setDebugValue('debug-claude-binary', getDebugLabel('binary', debugState.claudeBinary));
  setDebugValue('debug-platform', debugState.platform || I18N[lang].debug_state_unknown);
  setDebugValue('debug-bun-path', debugState.bunPath || I18N[lang].debug_state_unknown);
}

function setDebugPanelOpen(open) {
  debugPanelOpen = open;
  const panel = document.getElementById('debug-panel');
  const toggle = document.getElementById('debug-toggle');
  setHidden(panel, !open);
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
}

function updateDebugState(patch) {
  Object.assign(debugState, patch);
  renderDebugPanel();
}

async function loadDebugInfo() {
  if (!window.buddyAPI?.getDebugInfo) return;
  try {
    const info = await window.buddyAPI.getDebugInfo();
    updateDebugState({
      bunAvailable: info?.bunAvailable ? 'yes' : 'no',
      claudeBinary: info?.claudeBinaryDetected ? 'found' : 'missing',
      platform: info?.platform || 'unknown',
      bunPath: info?.bunResolvedPath || I18N[lang].debug_state_unknown,
      hashEngine: 'not-used',
      searchEngine: 'not-used',
    });
  } catch {
    updateDebugState({
      bunAvailable: 'unknown',
      platform: 'unknown',
      bunPath: I18N[lang].debug_state_unknown,
    });
  }
}

function syncEmptyStateGuide() {
  const emptyStateGuide = document.getElementById('empty-state-guide');
  if (!emptyStateGuide) return;
  setHidden(emptyStateGuide, searchActive || pool.length > 0);
}

function clampPercentage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function updateSearchProgress(m) {
  if (!searchActive) return;
  lastSearchProgress = m;
  if (searchStage !== 'organizing') searchStage = 'scanning';

  const done  = Math.max(0, Number(m.done)  || 0);
  const rawTotal = Number(m.total);
  const hasFiniteTotal = Number.isFinite(rawTotal) && rawTotal > 0;
  const total = hasFiniteTotal ? rawTotal : null;
  const pct   = hasFiniteTotal ? clampPercentage((done / total) * 100) : 0;
  const elapsed = Math.max(0.001, (Date.now() - searchStartedAt) / 1000);
  const rate    = done / elapsed;
  const etaSec  = hasFiniteTotal && done > 0 ? (total - done) / rate : Infinity;
  const stored    = Number.isFinite(Number(m.stored))    ? Number(m.stored)    : pool.length;
  const matches   = Number.isFinite(Number(m.matches))   ? Number(m.matches)   : stored;
  const bestTotal = Number.isFinite(Number(m.bestTotal)) ? Number(m.bestTotal) : null;
  const strings = I18N[lang];

  const progressFill = document.getElementById('progress-fill');
  if (hasFiniteTotal) {
    const roundedPct = Number(pct.toFixed(0));
    progressFill.style.width = `${roundedPct}%`;
    progressFill.setAttribute('aria-valuenow', String(roundedPct));
    document.getElementById('progress-text').textContent = `${roundedPct}%`;
  } else {
    progressFill.style.width = '0%';
    progressFill.setAttribute('aria-valuenow', '0');
    document.getElementById('progress-text').textContent = '...';
  }
  setResultCount(stored, matches);

  const base = hasFiniteTotal
    ? `${strings.search_metric_scanned} ${formatCompact(done)}/${formatCompact(total)} · ${strings.search_metric_rate} ${formatRate(rate)} · ${strings.search_metric_eta} ${formatClock(etaSec)}`
    : `${strings.search_metric_scanned} ${formatCompact(done)} · ${strings.search_metric_rate} ${formatRate(rate)}`;
  if (bestTotal !== null) {
    // Keep best score available for debug/log value, while rendering a simpler stage line to users.
    void `${base} · ${strings.search_metric_best} ${bestTotal}`;
  }
  updateSearchStageMetrics();
}

function clearLongSearchPromptTimer() {
  if (longSearchPromptTimer) {
    clearTimeout(longSearchPromptTimer);
    longSearchPromptTimer = null;
  }
}

function scheduleLongSearchPrompt() {
  clearLongSearchPromptTimer();
  longSearchPromptTimer = setTimeout(() => {
    if (!searchActive) return;
    const done = Number.isFinite(Number(lastSearchProgress?.done)) ? Number(lastSearchProgress.done) : 0;
    const found = pool.length;
    const elapsed = formatClock((Date.now() - searchStartedAt) / 1000);
    const strings = I18N[lang];
    const message = strings.search_prompt_msg
      .replace('{elapsed}', elapsed)
      .replace('{scanned}', formatCompact(done))
      .replace('{found}', formatCompact(found));
    const shouldContinue = window.confirm(message);
    if (!shouldContinue) {
      stopSearch();
      return;
    }
    scheduleLongSearchPrompt();
  }, 60000);
}

function refreshSearchUiText() {
  if (searchActive) {
    syncEmptyStateGuide();
    updateSearchStageMetrics();
    return;
  }
  syncEmptyStateGuide();
  setResultCount(pool.length);
  const strings = I18N[lang];
  if (lastSearchCompleted && completedMetricsHistory) {
    setSearchMetrics(completedMetricsHistory);
    return;
  }
  setSearchMetrics(lastSearchCompleted && pool.length > 0 ? strings.search_metrics_done : strings.search_metrics_idle);
}

// ── PRNG (Mulberry32 / SplitMix32) ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// ── JS Fallback Hash (Zig Wyhash Equivalent to Bun.hash) ──
const MASK64 = (1n << 64n) - 1n;
const WS0 = 0xa0761d6478bd642fn, WS1 = 0xe7037ed1a0b428dbn, WS2 = 0x8ebc6af09c88c6e3n, WS3 = 0x589965cc75374cc3n;

function _wmp(a, b) { a = a & MASK64; b = b & MASK64; const r = a * b; return [(r & MASK64), ((r >> 64n) & MASK64)]; }
function _wmx(a, b) { const [l, h] = _wmp(a, b); return l ^ h; }
function _r64(buf, o) { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(buf[o + i]) << BigInt(i * 8); return v; }
function _r32(buf, o) { let v = 0n; for (let i = 0; i < 4; i++) v |= BigInt(buf[o + i]) << BigInt(i * 8); return v; }

function wyhash32_fallback(str) {
  const buf = new TextEncoder().encode(str);
  const len = buf.length;
  let seed = 0n;
  seed = (seed ^ _wmx((seed ^ WS0) & MASK64, WS1)) & MASK64;
  let a, b, off = 0;

  if (len <= 16) {
    if (len >= 4) {
      a = ((_r32(buf, 0) << 32n) | _r32(buf, len - 4)) & MASK64;
      const d = (len >>> 3) << 2;
      b = ((_r32(buf, d) << 32n) | _r32(buf, len - 4 - d)) & MASK64;
    } else if (len > 0) {
      a = (BigInt(buf[0]) << 16n) | (BigInt(buf[len >> 1] || 0) << 8n) | BigInt(buf[len - 1] || 0);
      b = 0n;
    } else {
      a = 0n; b = 0n;
    }
  } else {
    let i = len;
    if (i > 48) {
      let s1 = seed, s2 = seed;
      while (i > 48) {
        seed = _wmx((_r64(buf, off)      ^ WS1) & MASK64, (_r64(buf, off +  8) ^ seed) & MASK64);
        s1   = _wmx((_r64(buf, off + 16) ^ WS2) & MASK64, (_r64(buf, off + 24) ^ s1)   & MASK64);
        s2   = _wmx((_r64(buf, off + 32) ^ WS3) & MASK64, (_r64(buf, off + 40) ^ s2)   & MASK64);
        off += 48; i -= 48;
      }
      seed = (seed ^ s1 ^ s2) & MASK64;
    }
    while (i > 16) {
      seed = _wmx((_r64(buf, off) ^ WS1) & MASK64, (_r64(buf, off + 8) ^ seed) & MASK64);
      off += 16; i -= 16;
    }
    a = _r64(buf, off + i - 16);
    b = _r64(buf, off + i - 8);
  }

  a = (a ^ WS1) & MASK64;
  b = (b ^ seed) & MASK64;
  const [lo, hi] = _wmp(a, b);
  return Number(_wmx((lo ^ WS0 ^ BigInt(len)) & MASK64, (hi ^ WS1) & MASK64) & 0xFFFFFFFFn);
}

async function fullRollAsync(uid, salt) {
  const buddyApi = window.buddyAPI;
  let seed;
  const cacheKey = `${uid}|${salt}`;
  if (hashSeedCache.has(cacheKey)) {
    seed = hashSeedCache.get(cacheKey);
  }

  if (buddyApi && buddyApi.calculateBunHash) {
    if (seed === undefined) {
      const res = await buddyApi.calculateBunHash(uid + salt);
      if (res.success) {
        seed = res.seed;
        updateDebugState({ hashEngine: 'bun' });
      }
    }
  }
  if (seed === undefined) {
    seed = wyhash32_fallback(uid + salt);
    updateDebugState({ hashEngine: 'javascript' });
  }
  if (hashSeedCache.size >= HASH_CACHE_MAX) {
    const firstKey = hashSeedCache.keys().next().value;
    hashSeedCache.delete(firstKey);
  }
  hashSeedCache.set(cacheKey, seed);

  const rng = mulberry32(seed);
  let rollVal = rng() * 100, rarity = 'common';
  for (const r of RARITIES) {
    rollVal -= RARITY_WEIGHTS[r];
    if (rollVal < 0) { rarity = r; break; }
  }
  const species = pick(rng, SPECIES);
  const eye     = pick(rng, EYES);
  const hat     = rarity !== 'common' ? pick(rng, HATS) : 'none';
  const shiny   = rng() < 0.01;
  const floor   = RARITY_FLOOR[rarity];
  const peakIdx = Math.floor(rng() * 5);
  let dumpIdx   = Math.floor(rng() * 5);
  while (dumpIdx === peakIdx) dumpIdx = Math.floor(rng() * 5);

  const stats = {};
  for (let i = 0; i < 5; i++) {
    const rv = rng();
    const n  = STAT_NAMES[i];
    if      (i === peakIdx) stats[n] = Math.min(100, floor + 50 + Math.floor(rv * 30));
    else if (i === dumpIdx) stats[n] = Math.max(1,   floor - 10 + Math.floor(rv * 15));
    else                    stats[n] = floor + Math.floor(rv * 40);
  }
  return { salt, rarity, species, eye, hat, shiny, d: stats.DEBUGGING, p: stats.PATIENCE, c: stats.CHAOS, w: stats.WISDOM, s: stats.SNARK };
}

// ── Environment Detection ──
const userIdInput = document.getElementById('userId');
const saltInput   = document.getElementById('saltInput');
const searchBtn   = document.getElementById('search-btn');

async function showCurrentBuddy(uid) {
  const salt = saltInput.value.trim();
  if (!uid || uid.length !== REQUIRED_UUID_LENGTH || salt.length !== REQUIRED_SALT_LENGTH) return;
  const buddy = await fullRollAsync(uid, salt);
  if (!buddy) return;
  selectBuddy(buddy, null);
  setHidden(document.getElementById('patch-hint'), true);
  setHidden(document.getElementById('patch-content'), false);
}

function resetCurrentBuddyPreview() {
  if (previewInterval) {
    clearInterval(previewInterval);
    previewInterval = null;
  }

  if (selectedCardElement) selectedCardElement.classList.remove('selected');
  selectedCardElement = null;
  selectedCardSprite = null;
  selectedBuddy = null;

  setPatchBusyState(false);
  setHidden(document.getElementById('patch-content'), true);
  setHidden(document.getElementById('patch-hint'), false);
  setHidden(document.getElementById('preview-shiny-tag'), true);

  const speciesEl = document.getElementById('preview-buddy-species');
  const rarityEl = document.getElementById('preview-rarity');
  const spriteEl = document.getElementById('preview-sprite');
  if (speciesEl) {
    speciesEl.textContent = '---';
    speciesEl.className = 'text-[12px] font-black text-primary tracking-tighter uppercase truncate';
  }
  if (rarityEl) {
    rarityEl.textContent = '---';
    rarityEl.className = 'text-[10px] font-mono mt-0.5 text-on-surface-variant';
  }
  if (spriteEl) {
    spriteEl.textContent = '';
    spriteEl.className = 'card-sprite';
  }

  for (const { statId, barId } of STAT_FIELDS) {
    const statEl = document.getElementById(statId);
    const barEl = document.getElementById(barId);
    if (statEl) statEl.textContent = '0';
    if (barEl) barEl.style.width = '0%';
  }
}

function clearBuddyResultsAndPreview() {
  if (searchActive) {
    stopSearch();
  }

  pool = [];
  rendered = 0;
  searchStage = 'idle';
  lastSearchProgress = null;
  scanCompletedCount = 0;
  completedMetricsHistory = '';
  lastSearchCompleted = false;

  const grid = document.getElementById('grid');
  if (grid) grid.innerHTML = '';

  setResultCount(0);
  setSearchMetrics(I18N[lang].search_metrics_idle);
  syncEmptyStateGuide();
  resetCurrentBuddyPreview();
}

userIdInput.addEventListener('input', async () => {
  clearBuddyResultsAndPreview();
  updateIdentityValidationUi();
  validateSearchPossibility();
  validateUpdateBtn();
});

saltInput.addEventListener('input', async () => {
  const val = userIdInput.value.trim();
  const validation = updateIdentityValidationUi();
  if (val.length === REQUIRED_UUID_LENGTH && validation.isSaltStrictValid) {
    await showCurrentBuddy(val);
    return;
  }
  if (val.length === REQUIRED_UUID_LENGTH) resetCurrentBuddyPreview();
});

document.getElementById('buddy-name').addEventListener('input', validateUpdateBtn);
document.getElementById('buddy-pers').addEventListener('input', validateUpdateBtn);

document.getElementById('autodetect-btn').addEventListener('click', async () => {
  let id = userIdInput.value.trim();
  const salt = saltInput.value.trim();

  if (!id && window.buddyAPI) {
    id = await window.buddyAPI.detectUserId();
    if (id) {
      userIdInput.value = id;
      saltInput.value = DEFAULT_SALT;
      showToast(I18N[lang].toast_ok_id, 'ok');
    } else {
      showToast(I18N[lang].toast_err_id, 'err');
      return;
    }
  }

  if (!id || !salt) {
    showToast(I18N[lang].toast_missing_fields, 'err');
    return;
  }
  if (id.length !== REQUIRED_UUID_LENGTH) {
    showToast(I18N[lang].toast_uuid_length, 'err');
    return;
  }
  if (salt.length !== REQUIRED_SALT_LENGTH) {
    showToast(I18N[lang].toast_salt_length, 'err');
    return;
  }

  clearBuddyResultsAndPreview();
  updateIdentityValidationUi();
  validateSearchPossibility();
  validateUpdateBtn();
  await showCurrentBuddy(id);
  if (window.buddyAPI) loadCurrentBuddyInfo();
});

document.getElementById('copy-salt-btn').addEventListener('click', () => {
  const salt = saltInput.value.trim();
  if (!salt) return;
  navigator.clipboard.writeText(salt)
    .then(() => {
      showToast(I18N[lang].toast_salt_copied, 'ok');
    })
    .catch(() => {
      showToast(I18N[lang].toast_copy_failed, 'err');
    });
});

async function loadCurrentBuddyInfo() {
  if (!window.buddyAPI) return;
  try {
    const res = await window.buddyAPI.getBuddyInfo();
    if (res.success && res.data) {
      const nameEl = document.getElementById('buddy-name');
      const persEl = document.getElementById('buddy-pers');
      if (nameEl) nameEl.value = res.data.name || '';
      if (persEl) persEl.value = res.data.personality || '';
      validateUpdateBtn();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`${I18N[lang].toast_load_info_failed}: ${message}`, 'err');
  }
}

async function updateBinaryStatus() {
  if (!window.buddyAPI) return;
  try {
    detectedBinaryPath = await window.buddyAPI.detectClaudePath();
    const dotB = document.getElementById('dot-binary');
    const txtB = document.getElementById('txt-binary');
    if (detectedBinaryPath) { dotB.className = 'dot ok';  txtB.textContent = I18N[lang].binary_found; }
    else                    { dotB.className = 'dot err'; txtB.textContent = I18N[lang].binary_not_found; }
    updateDebugState({ claudeBinary: detectedBinaryPath ? 'found' : 'missing' });

    const hasBak = await window.buddyAPI.hasBackup();
    const dotK      = document.getElementById('dot-backup');
    const txtK      = document.getElementById('txt-backup');
    const btnRestore = document.getElementById('btn-restore');
    const btnDelete  = document.getElementById('btn-delete-backup');

    if (hasBak) {
      dotK.className = 'dot ok'; txtK.textContent = I18N[lang].backup_exists;
      btnRestore.textContent = I18N[lang].btn_restore;
      btnRestore.onclick = async () => {
        const res = await window.buddyAPI.restoreBinary();
        if (res.success) { showToast(I18N[lang].toast_restored, 'ok'); updateBinaryStatus(); }
        else             { showToast(res.error, 'err'); }
      };
      if (btnDelete) {
        setHidden(btnDelete, false);
        btnDelete.onclick = async () => {
          const res = await window.buddyAPI.deleteBackup();
          if (res.success) { showToast(I18N[lang].backup_none, 'ok'); updateBinaryStatus(); }
          else             { showToast(res.error, 'err'); }
        };
      }
    } else {
      dotK.className = 'dot warn'; txtK.textContent = I18N[lang].backup_none;
      btnRestore.textContent = I18N[lang].btn_backup;
      btnRestore.onclick = async () => {
        const res = await window.buddyAPI.backupBinary();
        if (res.success) { showToast(I18N[lang].backup_exists, 'ok'); updateBinaryStatus(); }
        else             { showToast(res.error, 'err'); }
      };
      if (btnDelete) setHidden(btnDelete, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`${I18N[lang].binary_not_found}: ${message}`, 'err');
  }
}

// ── Card Rendering ──
function getStatLabel(i18nKey) {
  return I18N[lang]?.[i18nKey] ?? i18nKey;
}

function getSpeciesLabel(speciesKey) {
  const zhName = I18N.zh?.names?.[speciesKey] ?? speciesKey;
  const enName = I18N.en?.names?.[speciesKey] ?? speciesKey;
  if (lang === 'zh') return `${zhName} (${enName})`;
  return enName;
}

function statBarHtml(label, value, colorClass) {
  return `<div class="flex items-center gap-0.5"><span class="font-bold text-on-surface-variant w-20 shrink-0 uppercase tracking-tighter text-[10px]">${label}</span><div class="flex-1 h-0.5 bg-surface-container-low"><div class="h-full ${colorClass} stat-bar-fill" data-width="${value}"></div></div><span class="font-mono text-primary w-6 text-right text-[10px]">${value}</span></div>`;
}

function buildCardHtml(b) {
  return `<div class="card-header"><span class="card-name">${getSpeciesLabel(b.species)}${b.shiny ? ' ✨' : ''}</span><span class="card-rarity ${b.rarity}">${RARITY_STARS[b.rarity]}</span></div><div class="card-sprite ${b.rarity}">${renderSprite(b.species, b.eye, b.hat)}</div><div class="mt-auto border-t border-outline-variant/10 pt-1 space-y-0.5">${STAT_FIELDS.map(f => statBarHtml(getStatLabel(f.i18nKey), b[f.key], f.colorClass)).join('')}</div>`;
}

function rerenderVisibleCards() {
  const grid = document.getElementById('grid');
  if (!grid || rendered <= 0 || pool.length === 0) return;
  const cards = grid.querySelectorAll('.card');
  cards.forEach((card, idx) => {
    const b = pool[idx];
    if (!b) return;
    const wasSelected = card === selectedCardElement;
    card.innerHTML = buildCardHtml(b);
    card.querySelectorAll('.stat-bar-fill[data-width]').forEach((bar) => {
      bar.style.width = `${bar.dataset.width}%`;
    });
    if (wasSelected) {
      card.classList.add('selected');
      selectedCardElement = card;
      selectedCardSprite = card.querySelector('.card-sprite');
    }
  });
}

// ── Search Logic (Bun Powered) ──
function startSearchUi() {
  searchActive = true;
  updateDebugState({ searchEngine: 'bun' });
  searchStage = 'scanning';
  scanCompletedCount = 0;
  completedMetricsHistory = '';
  lastSearchCompleted = false;
  searchStartedAt = Date.now();
  lastSearchProgress = null;
  pool = [];
  rendered = 0;
  selectedCardElement = null;
  selectedCardSprite = null;

  document.getElementById('grid').innerHTML = '';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent = '0%';
  setHidden(document.getElementById('progress'), false);
  document.getElementById('progress').classList.add('searching');
  setHidden(searchBtn, true);
  setHidden(document.getElementById('stop-btn'), false);
  syncEmptyStateGuide();
  setResultCount(0);
  setSearchMetrics(I18N[lang].search_metrics_running);
  scheduleLongSearchPrompt();
}

searchBtn.addEventListener('click', () => {
  const userId = userIdInput.value.trim();
  const salt = saltInput.value.trim();
  if (!userId || !window.buddyAPI) return;
  if (userId.length !== REQUIRED_UUID_LENGTH) {
    showToast(I18N[lang].toast_uuid_length, 'err');
    return;
  }
  if (salt.length !== REQUIRED_SALT_LENGTH) {
    showToast(I18N[lang].toast_salt_length, 'err');
    return;
  }
  loadCurrentBuddyInfo();
  startSearchUi();
  window.buddyAPI.startBunSearch({ 
    userId, 
    filters: collectFilters(),
    totalAttempts: null,
    targetCount: SEARCH_TARGET_COUNT
  });
});

if (window.buddyAPI) {
  window.buddyAPI.onSearchProgress((m) => updateSearchProgress(m));

  window.buddyAPI.onSearchFoundOne((buddy) => {
    pool.push(buddy);
    setResultCount(pool.length);
    updateSearchStageMetrics();
    if (pool.length < RENDER_BATCH_SIZE) renderBatch();
  });

  window.buddyAPI.onSearchDone(() => {
    if (scanCompletedCount <= 0) {
      scanCompletedCount = Number.isFinite(Number(lastSearchProgress?.done)) ? Number(lastSearchProgress.done) : 0;
    }
    searchStage = 'done';
    pool.sort((a, b) => b.total - a.total);
    document.getElementById('grid').innerHTML = '';
    rendered = 0;
    lastSearchCompleted = true;
    setResultCount(pool.length);
    const strings = I18N[lang];
    const doneText = `${strings.search_metrics_done} (${formatClock((Date.now() - searchStartedAt) / 1000)})`;
    completedMetricsHistory = `[V] ${strings.search_metric_scanning_prefix} ${formatCompact(scanCompletedCount)} ${strings.search_metric_complete}\n[V] ${strings.search_metric_organizing_prefix} ${formatCompact(pool.length)}/${SEARCH_TARGET_COUNT}\n[V] ${doneText}`;
    setSearchMetrics(completedMetricsHistory);
    renderBatch();
    stopSearch({ signalMainProcess: false, markCompleted: true });
  });

  window.buddyAPI.onSearchError((err) => {
    console.warn('Bun search failed, falling back to Web Worker:', err);
    updateDebugState({ searchEngine: 'worker' });
    setSearchMetrics(I18N[lang].search_metrics_running);
    startWorkerSearch(userIdInput.value.trim());
  });
}

function stopWorkerSearch() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function startWorkerSearch(userId) {
  updateDebugState({ searchEngine: 'worker' });
  stopWorkerSearch();
  worker = new Worker('../worker/search-worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'current') return;
    if (m.type === 'progress') updateSearchProgress(m);
    else if (m.type === 'buddy') {
      pool.push(m.data);
      setResultCount(pool.length);
      updateSearchStageMetrics();
      if (pool.length < RENDER_BATCH_SIZE) renderBatch();
    } else if (m.type === 'error') {
      const strings = I18N[lang];
      showToast(m.error || strings.err_worker_failed, 'err');
      stopSearch({ signalMainProcess: false, markCompleted: false });
    } else if (m.type === 'done') {
      pool = m.pool;
      if (scanCompletedCount <= 0) {
        scanCompletedCount = Number.isFinite(Number(lastSearchProgress?.done)) ? Number(lastSearchProgress.done) : 0;
      }
      searchStage = 'done';
      lastSearchCompleted = true;
      setResultCount(pool.length);
      const strings = I18N[lang];
      const doneText = `${strings.search_metrics_done} (${formatClock((Date.now() - searchStartedAt) / 1000)})`;
      completedMetricsHistory = `[V] ${strings.search_metric_scanning_prefix} ${formatCompact(scanCompletedCount)} ${strings.search_metric_complete}\n[V] ${strings.search_metric_organizing_prefix} ${formatCompact(pool.length)}/${SEARCH_TARGET_COUNT}\n[V] ${doneText}`;
      setSearchMetrics(completedMetricsHistory);
      document.getElementById('grid').innerHTML = '';
      rendered = 0;
      renderBatch();
      stopSearch({ signalMainProcess: false, markCompleted: true });
    }
  };
  worker.postMessage({ 
    userId, 
    filters: collectFilters(),
    totalAttempts: null,
    targetCount: SEARCH_TARGET_COUNT
  });
}

function stopSearch({ signalMainProcess = true, markCompleted = false } = {}) {
  if (signalMainProcess && window.buddyAPI) window.buddyAPI.stopSearch();
  stopWorkerSearch();
  searchActive = false;
  
  // 重要：如果是中途手動停止且已有結果，將其視為「完成」的一種狀態，以保留 UI 文字
  if (!markCompleted && pool.length > 0) {
    lastSearchCompleted = true;
    const strings = I18N[lang];
    const doneText = `${strings.search_metrics_done} (${formatClock((Date.now() - searchStartedAt) / 1000)})`;
    if (scanCompletedCount <= 0) scanCompletedCount = Number.isFinite(Number(lastSearchProgress?.done)) ? Number(lastSearchProgress.done) : 0;
    completedMetricsHistory = `[V] ${strings.search_metric_scanning_prefix} ${formatCompact(scanCompletedCount)} ${strings.search_metric_complete}\n[V] ${strings.search_metric_organizing_prefix} ${formatCompact(pool.length)}/${SEARCH_TARGET_COUNT}\n[V] ${doneText}`;
  } else if (!markCompleted) {
    completedMetricsHistory = '';
    lastSearchCompleted = false;
  }
  
  searchStage = (markCompleted || pool.length > 0) ? 'done' : 'idle';
  setHidden(searchBtn, false);
  setHidden(document.getElementById('stop-btn'), true);
  document.getElementById('progress').classList.remove('searching');
  setHidden(document.getElementById('progress'), true);
  clearLongSearchPromptTimer();
  
  refreshSearchUiText();
  syncEmptyStateGuide();
  setResultCount(pool.length);
  
  // 確保中途停止時，現有的 pool 被正確排序並渲染
  if (!markCompleted && pool.length > 0) {
    pool.sort((a, b) => b.total - a.total);
    document.getElementById('grid').innerHTML = '';
    rendered = 0;
    renderBatch();
  }
}

document.getElementById('stop-btn').addEventListener('click', () => stopSearch());

document.getElementById('debug-toggle').addEventListener('click', (event) => {
  event.stopPropagation();
  setDebugPanelOpen(!debugPanelOpen);
});

document.addEventListener('click', (event) => {
  const panel = document.getElementById('debug-panel');
  const toggle = document.getElementById('debug-toggle');
  if (!debugPanelOpen) return;
  if (panel?.contains(event.target) || toggle?.contains(event.target)) return;
  setDebugPanelOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && debugPanelOpen) setDebugPanelOpen(false);
});

function renderBatch() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const end  = Math.min(rendered + RENDER_BATCH_SIZE, pool.length);
  const frag = document.createDocumentFragment();
  for (let i = rendered; i < end; i++) {
    const b    = pool[i];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = buildCardHtml(b);
    card.querySelectorAll('.stat-bar-fill[data-width]').forEach((bar) => {
      bar.style.width = `${bar.dataset.width}%`;
    });
    card.addEventListener('click', () => selectBuddy(b, card));
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  rendered = end;
}

const obs = new IntersectionObserver(
  entries => { if (entries[0].isIntersecting && rendered < pool.length) renderBatch(); },
  { rootMargin: '400px' }
);
obs.observe(document.getElementById('sentinel'));

async function selectBuddy(b, card) {
  if (selectedCardSprite && selectedBuddy) {
    selectedCardSprite.textContent = renderSprite(selectedBuddy.species, selectedBuddy.eye, selectedBuddy.hat, 0);
  }
  if (selectedCardElement) selectedCardElement.classList.remove('selected');
  if (card) {
    card.classList.add('selected');
    selectedCardElement = card;
  } else {
    selectedCardElement = null;
  }
  selectedBuddy = b;
  selectedCardSprite = card ? card.querySelector('.card-sprite') : null;

  setHidden(document.getElementById('patch-hint'), true);
  setHidden(document.getElementById('patch-content'), false);
  
  const speciesEl = document.getElementById('preview-buddy-species');
  speciesEl.textContent = b.species.toUpperCase();
  speciesEl.className = `text-[12px] font-black tracking-tighter uppercase truncate text-${b.rarity}`;

  saltInput.value = b.salt;

  const rarityEl = document.getElementById('preview-rarity');
  rarityEl.textContent = RARITY_STARS[b.rarity];
  rarityEl.className = `text-[10px] font-mono mt-0.5 text-${b.rarity}`;

  if (previewInterval) clearInterval(previewInterval);
  let frame = 0;
  const mainPreviewEl = document.getElementById('preview-sprite');
  mainPreviewEl.className = `card-sprite ${b.rarity}`;
  const updateSprites = () => {
    const content = renderSprite(b.species, b.eye, b.hat, frame++);
    mainPreviewEl.textContent = content;
    if (selectedCardSprite) selectedCardSprite.textContent = content;
  };
  updateSprites();
  previewInterval = setInterval(updateSprites, 500);

  setHidden(document.getElementById('preview-shiny-tag'), !b.shiny);

  for (const { statId, barId, key } of STAT_FIELDS) {
    document.getElementById(statId).textContent = b[key];
    document.getElementById(barId).style.width  = `${clampPercentage(b[key])}%`;
  }
}

document.getElementById('btn-patch-now').onclick = async () => {
  const id = userIdInput.value.trim();
  const salt = saltInput.value.trim();

  // 1. Validate inputs
  if (!id || !salt) {
    showToast(I18N[lang].toast_missing_fields, 'err');
    return;
  }
  if (id.length !== REQUIRED_UUID_LENGTH) {
    showToast(I18N[lang].toast_uuid_length, 'err');
    return;
  }
  if (salt.length !== REQUIRED_SALT_LENGTH) {
    showToast(I18N[lang].toast_salt_length, 'err');
    return;
  }

  // 2. Pre-patch validation: Ensure we can actually "find" (generate) a buddy with this salt
  setPatchBusyState(true);
  try {
    // Force refresh preview to match current input
    await showCurrentBuddy(id);
    
    // Double check if selectedBuddy is now valid and matches the input salt
    if (!selectedBuddy || selectedBuddy.salt !== salt) {
      throw new Error(I18N[lang].toast_err_invalid_buddy || 'Could not generate a valid buddy with this salt.');
    }

    const res = await window.buddyAPI.patchBinary(salt);
    if (res.success) {
      showToast(I18N[lang].toast_patched, 'ok');
      updateBinaryStatus();
    } else {
      showToast(res.error, 'err');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(message, 'err');
  } finally {
    setPatchBusyState(false);
  }
};

document.getElementById('btn-update-info').onclick = async () => {
  if (!window.buddyAPI) return;
  const name = document.getElementById('buddy-name').value.trim();
  const personality = document.getElementById('buddy-pers').value.trim();
  const res = await window.buddyAPI.updateBuddyInfo(name, personality);
  if (res.success) { showToast(I18N[lang].toast_updated, 'ok'); }
  else             { showToast(res.error, 'err'); }
};

let toastTimer;
function showToast(message, type) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.classList.remove('ok', 'err', 'show');
  void t.offsetWidth; // force reflow to restart CSS transition
  t.classList.add('show', type);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

setLang('zh'); updateBinaryStatus(); validateUpdateBtn(); syncEmptyStateGuide(); loadDebugInfo();
updateIdentityValidationUi();
