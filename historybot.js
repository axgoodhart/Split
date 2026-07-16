(function () {
  'use strict';

  const TOPIC_COLORS = ['#3B73E8', '#C18B13', '#18A6A8', '#D85F74', '#8A70D6'];
  const CALENDAR_COLORS = ['#182129', '#133222', '#14532D', '#1F7A3D', '#5BD46D'];
  const MEASURE_LABELS = {
    messages: 'Matching messages',
    mentions: 'Mentions',
    conversations: 'Conversations',
  };
  const state = {
    response: null,
    view: 'frequency',
    measure: 'messages',
    granularity: 'auto',
    calendarTopicId: null,
    calendarYear: null,
    chart: null,
    requestController: null,
    openedOnce: false,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };

  const elements = {};
  let nextTopicId = 1;
  let resizeObserver = null;

  function cacheElements() {
    const ids = [
      'main-image', 'historybot', 'historybot-close', 'historybot-status', 'historybot-form',
      'historybot-topic-list', 'historybot-add-topic', 'historybot-options', 'historybot-custom-dates',
      'historybot-date-start', 'historybot-date-end', 'historybot-generate', 'historybot-output',
      'historybot-tab-calendar', 'historybot-tab-frequency', 'historybot-measure',
      'historybot-granularity', 'historybot-granularity-wrap', 'historybot-calendar-topic',
      'historybot-calendar-topic-wrap', 'historybot-calendar-year', 'historybot-calendar-year-wrap',
      'historybot-save-png', 'historybot-summary', 'historybot-chart', 'historybot-empty', 'historybot-error',
    ];
    ids.forEach(id => { elements[id] = document.getElementById(id); });
  }

  function addTopicRow(value = '') {
    if (elements['historybot-topic-list'].children.length >= 5) return;
    const number = nextTopicId++;
    const row = document.createElement('div');
    row.className = 'historybot-topic-row';
    const label = document.createElement('label');
    label.htmlFor = `historybot-topic-${number}`;
    label.textContent = `Topic ${number}`;
    const input = document.createElement('input');
    input.id = `historybot-topic-${number}`;
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = number === 1 ? 'e.g. historybot' : 'Comparison topic';
    input.value = value;
    row.append(label, input);
    if (elements['historybot-topic-list'].children.length > 0) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'historybot-remove-topic';
      remove.setAttribute('aria-label', `Remove topic ${number}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removeTopicRow(row));
      row.append(remove);
    }
    elements['historybot-topic-list'].append(row);
    elements['historybot-add-topic'].disabled = elements['historybot-topic-list'].children.length >= 5;
    if (value) input.focus();
  }

  function removeTopicRow(row) {
    row.remove();
    elements['historybot-add-topic'].disabled = false;
  }

  function openHistorybot() {
    const panel = elements.historybot;
    panel.hidden = false;
    panel.classList.add('is-open');
    requestAnimationFrame(() => {
      state.chart?.resize();
      if (!state.openedOnce) {
        elements['historybot-topic-list'].querySelector('input')?.focus();
        state.openedOnce = true;
      }
    });
  }

  function closeHistorybot() {
    elements.historybot.classList.remove('is-open');
    elements.historybot.hidden = true;
    elements['main-image'].focus?.();
  }

  function collectRequest() {
    const topics = [...elements['historybot-topic-list'].querySelectorAll('input[type="text"]')].map(input => input.value);
    const role = document.querySelector('input[name="historybot-role"]:checked')?.value || 'both';
    const roles = role === 'both' ? ['user', 'assistant'] : [role];
    const custom = document.querySelector('input[name="historybot-date-mode"]:checked')?.value === 'custom';
    return {
      topics,
      roles,
      dateRange: custom ? {
        start: elements['historybot-date-start'].value || null,
        end: elements['historybot-date-end'].value || null,
      } : { start: null, end: null },
    };
  }

  function setHistorybotBusy(isBusy) {
    elements['historybot-output'].setAttribute('aria-busy', String(isBusy));
    elements['historybot-generate'].disabled = isBusy;
    elements['historybot-generate'].textContent = isBusy ? 'Counting matches…' : 'Create infographic';
    if (isBusy) elements['historybot-status'].textContent = 'Counting matches locally…';
  }

  async function submitHistorybot(event) {
    event.preventDefault();
    state.requestController?.abort();
    state.requestController = new AbortController();
    const controller = state.requestController;
    renderError('');
    setHistorybotBusy(true);
    try {
      const response = await fetch('/api/historybot/infographics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectRequest()),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Historybot could not create this infographic.');
      if (controller !== state.requestController) return;
      state.response = payload;
      state.calendarTopicId = payload.query.topics[0]?.id || null;
      state.calendarYear = latestYear(payload.meta.appliedRange);
      if (payload.query.isAllActivity && state.measure === 'mentions') state.measure = 'messages';
      elements['historybot-status'].textContent = `Counted ${payload.meta.eligibleMessages.toLocaleString()} eligible messages in ${payload.meta.durationMs} ms.`;
      renderHistorybot();
    } catch (error) {
      if (error.name !== 'AbortError' && controller === state.requestController) renderError(error.message);
    } finally {
      if (controller === state.requestController) setHistorybotBusy(false);
    }
  }

  function latestYear(range) {
    return range?.end?.slice(0, 4) || null;
  }

  function updateSelect(select, items, selectedValue) {
    select.replaceChildren();
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.append(option);
    });
    if (items.some(item => item.value === selectedValue)) select.value = selectedValue;
  }

  function updateControlVisibility() {
    const calendar = state.view === 'calendar';
    const response = state.response;
    elements['historybot-tab-calendar'].setAttribute('aria-selected', String(calendar));
    elements['historybot-tab-frequency'].setAttribute('aria-selected', String(!calendar));
    elements['historybot-granularity-wrap'].hidden = calendar;
    elements['historybot-calendar-year-wrap'].hidden = !calendar || !response?.meta.appliedRange;
    elements['historybot-calendar-topic-wrap'].hidden = !calendar || (response?.series.length || 0) <= 1;
    elements['historybot-measure'].value = state.measure;
    elements['historybot-granularity'].value = state.granularity;
    const mentionsOption = elements['historybot-measure'].querySelector('option[value="mentions"]');
    mentionsOption.disabled = Boolean(response?.query.isAllActivity);
    mentionsOption.textContent = response?.query.isAllActivity ? 'Mentions (same as messages)' : 'Mentions';
    mentionsOption.title = response?.query.isAllActivity ? 'All activity counts every eligible message once.' : '';
  }

  function renderHistorybot() {
    updateControlVisibility();
    const response = state.response;
    if (!response) return renderEmptyState('Add a topic—or leave it blank for all activity—then create an infographic.');
    updateSelect(elements['historybot-calendar-topic'], response.series.map(series => ({ value: series.id, label: series.label })), state.calendarTopicId);
    if (!response.series.some(series => series.id === state.calendarTopicId)) state.calendarTopicId = response.series[0]?.id || null;
    const range = response.meta.appliedRange;
    const years = [];
    if (range) {
      for (let year = Number(range.start.slice(0, 4)); year <= Number(range.end.slice(0, 4)); year++) years.push({ value: String(year), label: String(year) });
    }
    if (!years.some(year => year.value === state.calendarYear)) state.calendarYear = years.at(-1)?.value || null;
    updateSelect(elements['historybot-calendar-year'], years, state.calendarYear);
    updateControlVisibility();
    if (!range || response.series.every(series => series.totals.messages === 0)) {
      return renderEmptyState('No matches in this range. Try a broader phrase, another message source, or all history.');
    }
    elements['historybot-empty'].hidden = true;
    elements['historybot-chart'].hidden = false;
    renderError('');
    ensureChart();
    state.chart.clear();
    if (state.view === 'calendar') renderCalendarChart();
    else renderFrequencyChart();
    elements['historybot-save-png'].disabled = false;
  }

  function ensureChart() {
    if (!window.echarts) throw new Error('The local chart library is unavailable. Restart Split and try again.');
    if (!state.chart) state.chart = window.echarts.init(elements['historybot-chart'], null, { renderer: 'canvas' });
  }

  function roleLabel() {
    const roles = state.response.query.roles;
    if (roles.length === 2) return 'Both';
    return roles[0] === 'user' ? 'You' : 'Assistant';
  }

  function subtitle(interval) {
    const meta = state.response.meta;
    return `${MEASURE_LABELS[state.measure]} · ${roleLabel()} · ${interval} · ${formatRange(meta.appliedRange)} · ${meta.timezone}`;
  }

  function formatRange(range) {
    return range ? `${range.start} to ${range.end}` : 'No overlapping dates';
  }

  function frequencyTitle() {
    if (state.response.query.isAllActivity) return 'All Historybot activity';
    return state.response.series.map(series => series.label).join(' vs ');
  }

  function resolvedGranularity() {
    return state.granularity === 'auto' ? state.response.meta.recommendedGranularity : state.granularity;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function buildFrequencyOption(granularity) {
    const buckets = state.response.series[0].buckets[granularity];
    const useZoom = buckets.length > 120;
    const series = state.response.series.map((item, index) => ({
      name: item.label,
      type: 'line',
      data: item.buckets[granularity].map(bucket => [bucket.start, bucket[state.measure]]),
      lineStyle: { width: 3, type: index === 3 ? 'dashed' : index === 4 ? 'dotted' : 'solid' },
      itemStyle: { color: TOPIC_COLORS[index] },
      smooth: .2,
      showSymbol: false,
      emphasis: { focus: 'series', scale: true },
    }));
    return {
      animation: !state.reducedMotion,
      backgroundColor: '#0C1116',
      color: TOPIC_COLORS,
      aria: { enabled: true, decal: { show: true } },
      title: {
        text: frequencyTitle(),
        subtext: subtitle(granularity[0].toUpperCase() + granularity.slice(1)),
        left: 16,
        top: 8,
        textStyle: { color: '#D8E2EA', fontFamily: 'Georgia', fontSize: 20, fontWeight: 400 },
        subtextStyle: { color: '#8E9AA5', fontSize: 11 },
      },
      legend: { top: 62, left: 12, right: 12, textStyle: { color: '#D8E2EA' }, type: 'scroll' },
      grid: { left: 54, right: 24, top: 108, bottom: useZoom ? 72 : 42, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: '#64737f' } },
        backgroundColor: '#182129',
        borderColor: '#35434e',
        textStyle: { color: '#D8E2EA' },
        formatter(params) {
          const date = params[0]?.value?.[0] || '';
          return [`<strong>${escapeHtml(date)}</strong>`, ...params.map(param => `${param.marker} ${escapeHtml(param.seriesName)}: ${Number(param.value[1]).toLocaleString()}`)].join('<br>');
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: '#46515a' } },
        axisLabel: { color: '#8E9AA5', hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        minInterval: 1,
        axisLabel: { color: '#8E9AA5', formatter: value => Number.isInteger(value) ? value : '' },
        splitLine: { lineStyle: { color: '#283139' } },
      },
      dataZoom: useZoom ? [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 18, borderColor: '#283139', backgroundColor: '#111920', fillerColor: 'rgba(59,115,232,.22)', textStyle: { color: '#8E9AA5' } },
      ] : [],
      series,
    };
  }

  function renderFrequencyChart() {
    const granularity = resolvedGranularity();
    state.chart.setOption(buildFrequencyOption(granularity), true);
    const total = state.response.series.reduce((sum, series) => sum + series.totals[state.measure], 0);
    elements['historybot-summary'].textContent = `${total.toLocaleString()} ${MEASURE_LABELS[state.measure].toLowerCase()} across ${state.response.series.length} ${state.response.series.length === 1 ? 'series' : 'series'}.`;
    elements['historybot-chart'].setAttribute('aria-label', `${frequencyTitle()}. ${subtitle(granularity)}. Total ${total}.`);
  }

  function percentile95(values) {
    const nonzero = values.filter(value => value > 0).sort((a, b) => a - b);
    if (!nonzero.length) return 1;
    return Math.max(1, nonzero[Math.ceil(nonzero.length * .95) - 1]);
  }

  function calendarRange() {
    const applied = state.response.meta.appliedRange;
    const yearStart = `${state.calendarYear}-01-01`;
    const yearEnd = `${state.calendarYear}-12-31`;
    return [applied.start > yearStart ? applied.start : yearStart, applied.end < yearEnd ? applied.end : yearEnd];
  }

  function buildCalendarOption(series) {
    const range = calendarRange();
    const buckets = series.buckets.day.filter(bucket => bucket.start >= range[0] && bucket.start <= range[1]);
    const values = buckets.map(bucket => bucket[state.measure]);
    const bucketMap = new Map(buckets.map(bucket => [bucket.start, bucket]));
    return {
      animation: !state.reducedMotion,
      backgroundColor: '#0C1116',
      aria: { enabled: true },
      title: {
        text: `Historybot activity: ${series.label}`,
        subtext: subtitle(String(state.calendarYear)),
        left: 16,
        top: 8,
        textStyle: { color: '#D8E2EA', fontFamily: 'Georgia', fontSize: 20, fontWeight: 400 },
        subtextStyle: { color: '#8E9AA5', fontSize: 11 },
      },
      tooltip: {
        backgroundColor: '#182129',
        borderColor: '#35434e',
        textStyle: { color: '#D8E2EA' },
        formatter(param) {
          const bucket = bucketMap.get(param.value[0]);
          if (!bucket) return '';
          return [
            `<strong>${escapeHtml(param.value[0])}</strong>`,
            `${escapeHtml(series.label)} · ${MEASURE_LABELS[state.measure]}: ${bucket[state.measure].toLocaleString()}`,
            `Matching messages: ${bucket.messages.toLocaleString()}`,
            `Mentions: ${bucket.mentions.toLocaleString()}`,
            `Conversations: ${bucket.conversations.toLocaleString()}`,
          ].join('<br>');
        },
      },
      visualMap: {
        show: true,
        min: 0,
        max: percentile95(values),
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        itemWidth: 110,
        itemHeight: 10,
        text: ['More', 'Less'],
        textStyle: { color: '#8E9AA5', fontSize: 10 },
        inRange: { color: CALENDAR_COLORS },
      },
      calendar: {
        range,
        top: 106,
        left: 55,
        right: 24,
        bottom: 56,
        cellSize: ['auto', 18],
        splitLine: { show: false },
        itemStyle: { color: CALENDAR_COLORS[0], borderColor: '#0C1116', borderWidth: 3 },
        dayLabel: { firstDay: 0, nameMap: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], color: '#8E9AA5', fontSize: 10 },
        monthLabel: { show: true, color: '#AAB6BF', fontSize: 11, margin: 12 },
        yearLabel: { show: false },
      },
      series: [{
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: buckets.map(bucket => [bucket.start, bucket[state.measure]]),
        emphasis: { itemStyle: { borderColor: '#78A7FF', borderWidth: 2 } },
      }],
    };
  }

  function renderCalendarChart() {
    const series = state.response.series.find(item => item.id === state.calendarTopicId) || state.response.series[0];
    state.calendarTopicId = series.id;
    state.chart.setOption(buildCalendarOption(series), true);
    const yearBuckets = series.buckets.day.filter(bucket => bucket.start.startsWith(`${state.calendarYear}-`));
    const total = yearBuckets.reduce((sum, bucket) => sum + bucket[state.measure], 0);
    elements['historybot-summary'].textContent = `${total.toLocaleString()} ${MEASURE_LABELS[state.measure].toLowerCase()} for ${series.label} in ${state.calendarYear}.`;
    elements['historybot-chart'].setAttribute('aria-label', `Calendar for ${series.label} in ${state.calendarYear}. Total ${total} ${MEASURE_LABELS[state.measure].toLowerCase()}.`);
  }

  function renderEmptyState(message) {
    state.chart?.clear();
    elements['historybot-chart'].hidden = true;
    elements['historybot-empty'].hidden = false;
    elements['historybot-empty'].textContent = message;
    elements['historybot-summary'].textContent = '';
    elements['historybot-save-png'].disabled = true;
  }

  function renderError(message) {
    elements['historybot-error'].textContent = message || '';
    if (message) elements['historybot-status'].textContent = message;
  }

  function slugify(value) {
    return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').replace(/-+/g, '-').slice(0, 60) || 'activity';
  }

  function saveCurrentChartPng() {
    if (!state.chart || !state.response?.meta.appliedRange) return;
    const dataUrl = state.chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#0C1116' });
    const topic = state.response.series.map(series => series.label).join('-vs-');
    const range = state.response.meta.appliedRange;
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = `historybot-${state.view}-${slugify(topic)}-${range.start}-to-${range.end}.png`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  async function loadStatus() {
    try {
      const response = await fetch('/api/historybot/status');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ready) throw new Error(payload.error?.message || "Historybot's local index is unavailable.");
      const range = payload.sourceRange;
      elements['historybot-date-start'].min = range.start;
      elements['historybot-date-start'].max = range.end;
      elements['historybot-date-end'].min = range.start;
      elements['historybot-date-end'].max = range.end;
      elements['historybot-date-start'].value = range.start;
      elements['historybot-date-end'].value = range.end;
      elements['historybot-status'].textContent = `${payload.stats.messages.toLocaleString()} messages indexed · ${payload.timezone}`;
    } catch (error) {
      elements['historybot-status'].textContent = error.message;
      elements['historybot-generate'].disabled = true;
    }
  }

  function bindEvents() {
    elements['main-image'].addEventListener('click', () => elements.historybot.hidden ? openHistorybot() : closeHistorybot());
    elements['historybot-close'].addEventListener('click', closeHistorybot);
    elements.historybot.addEventListener('keydown', event => {
      if (event.key === 'Escape' && elements.historybot.contains(document.activeElement)) closeHistorybot();
    });
    elements['historybot-add-topic'].addEventListener('click', () => addTopicRow(''));
    elements['historybot-form'].addEventListener('submit', submitHistorybot);
    document.querySelectorAll('input[name="historybot-date-mode"]').forEach(input => input.addEventListener('change', () => {
      elements['historybot-custom-dates'].hidden = input.value !== 'custom' || !input.checked;
    }));
    elements['historybot-tab-calendar'].addEventListener('click', () => { state.view = 'calendar'; renderHistorybot(); });
    elements['historybot-tab-frequency'].addEventListener('click', () => { state.view = 'frequency'; renderHistorybot(); });
    elements['historybot-measure'].addEventListener('change', event => { state.measure = event.target.value; renderHistorybot(); });
    elements['historybot-granularity'].addEventListener('change', event => { state.granularity = event.target.value; renderHistorybot(); });
    elements['historybot-calendar-topic'].addEventListener('change', event => { state.calendarTopicId = event.target.value; renderHistorybot(); });
    elements['historybot-calendar-year'].addEventListener('change', event => { state.calendarYear = event.target.value; renderHistorybot(); });
    elements['historybot-save-png'].addEventListener('click', saveCurrentChartPng);
    window.addEventListener('resize', () => state.chart?.resize());
    resizeObserver = new ResizeObserver(() => {
      if (!elements.historybot.hidden) state.chart?.resize();
    });
    resizeObserver.observe(elements['historybot-chart']);
  }

  function initHistorybot() {
    cacheElements();
    addTopicRow();
    bindEvents();
    updateControlVisibility();
    loadStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initHistorybot, { once: true });
  else initHistorybot();
}());
