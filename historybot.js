(function () {
  'use strict';

  const TOPIC_COLORS = ['#3B73E8', '#C18B13', '#18A6A8', '#D85F74', '#8A70D6'];
  const CALENDAR_COLORS = ['#182129', '#133222', '#14532D', '#1F7A3D', '#5BD46D'];
  const MEASURE_LABELS = {
    messages: 'Matching messages',
    mentions: 'Mentions',
    conversations: 'Conversations',
  };
  // ==== TOPIC LIMITS (mirror historybot-analytics.js) ====
  const MAX_TOPICS = 5;
  const MAX_TERMS = 8;
  const MAX_OR = 2;
  const OPERATORS = ['AND', 'OR', 'WITHOUT'];

  const state = {
    response: null,
    view: 'frequency',
    measure: 'messages',
    granularity: 'auto',
    calendarTopicId: null,
    calendarYear: null,
    chart: null,
    requestController: null,
    drill: null,       // { topicId, topic, start, end, label, response, results, error, controller }
    canDrill: false,   // index has conversation refs (status.messageSearch)
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
      'historybot-save-png', 'historybot-summary', 'historybot-browse', 'historybot-chart', 'historybot-empty', 'historybot-error',
      'historybot-drilldown', 'historybot-drilldown-title', 'historybot-drilldown-meta', 'historybot-drilldown-topics',
      'historybot-drilldown-close', 'historybot-drilldown-note', 'historybot-drilldown-list',
    ];
    ids.forEach(id => { elements[id] = document.getElementById(id); });
  }

  // ---- Topic rows: each row is a strip of term inputs separated by AND / OR / WITHOUT pills ----

  function createTermInput(topicNumber, termNumber, value, placeholder) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'historybot-term';
    input.maxLength = 80;
    input.autocomplete = 'off';
    input.placeholder = placeholder;
    input.value = value;
    if (termNumber === 1) input.id = `historybot-topic-${topicNumber}`;
    else input.setAttribute('aria-label', `Topic ${topicNumber} term ${termNumber}`);
    return input;
  }

  function createPill(operator, row) {
    const pill = document.createElement('span');
    pill.className = `bool-pill historybot-pill ${operator.toLowerCase()}`; // .or / .without colors come from the search bar
    pill.dataset.op = operator;
    pill.append(document.createTextNode(operator));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'historybot-pill-remove';
    remove.setAttribute('aria-label', `Remove ${operator} term`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const next = pill.nextElementSibling;
      if (next?.matches('input')) next.remove();
      pill.remove();
      updateTermOps(row);
      row.querySelector('.historybot-terms input:last-of-type')?.focus();
    });
    pill.append(remove);
    return pill;
  }

  function addTerm(row, operator) {
    const terms = row.querySelector('.historybot-terms');
    const inputs = terms.querySelectorAll('input');
    if (inputs.length >= MAX_TERMS) return;
    if (operator === 'OR' && terms.querySelectorAll('.historybot-pill.or').length >= MAX_OR) return;
    const input = createTermInput(Number(row.dataset.topic), inputs.length + 1, '', operator === 'WITHOUT' ? 'Exclude…' : 'Term…');
    terms.append(createPill(operator, row), input);
    updateTermOps(row);
    input.focus();
  }

  function updateTermOps(row) {
    const terms = row.querySelector('.historybot-terms');
    const inputs = [...terms.querySelectorAll('input')];
    const ops = row.querySelector('.historybot-term-ops');
    ops.hidden = !inputs.some(input => input.value.trim());
    const orCount = terms.querySelectorAll('.historybot-pill.or').length;
    ops.querySelectorAll('button').forEach(button => {
      button.disabled = inputs.length >= MAX_TERMS || (button.dataset.op === 'OR' && orCount >= MAX_OR);
    });
  }

  function addTopicRow(value = '') {
    if (elements['historybot-topic-list'].children.length >= MAX_TOPICS) return;
    const number = nextTopicId++;
    const row = document.createElement('div');
    row.className = 'historybot-topic-row';
    row.dataset.topic = String(number);
    const label = document.createElement('label');
    label.htmlFor = `historybot-topic-${number}`;
    label.textContent = `Topic ${number}`;
    const terms = document.createElement('div');
    terms.className = 'historybot-terms';
    terms.append(createTermInput(number, 1, value, number === 1 ? 'e.g. historybot' : 'Comparison topic'));
    terms.addEventListener('input', () => updateTermOps(row));
    const ops = document.createElement('div');
    ops.className = 'historybot-term-ops';
    ops.hidden = true;
    OPERATORS.forEach(operator => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.op = operator;
      button.textContent = `+ ${operator}`;
      button.title = `Add a term this topic must ${operator === 'WITHOUT' ? 'not contain' : operator === 'OR' ? 'contain instead' : 'also contain'}`;
      button.addEventListener('click', () => addTerm(row, operator));
      ops.append(button);
    });
    row.append(label, terms, ops);
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
    elements['historybot-add-topic'].disabled = elements['historybot-topic-list'].children.length >= MAX_TOPICS;
    updateTermOps(row);
    if (value) terms.querySelector('input').focus();
  }

  function removeTopicRow(row) {
    row.remove();
    elements['historybot-add-topic'].disabled = false;
  }

  // One topic -> { terms: [{ value, operator }] } in visual order, like the search bar's segments.
  function collectTopics() {
    return [...elements['historybot-topic-list'].querySelectorAll('.historybot-terms')].map(terms => ({
      terms: [...terms.children].filter(element => element.matches('input')).map(input => ({
        value: input.value,
        operator: input.previousElementSibling?.classList.contains('historybot-pill') ? input.previousElementSibling.dataset.op : 'AND',
      })),
    }));
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
    const role = document.querySelector('input[name="historybot-role"]:checked')?.value || 'both';
    const roles = role === 'both' ? ['user', 'assistant'] : [role];
    const custom = document.querySelector('input[name="historybot-date-mode"]:checked')?.value === 'custom';
    return {
      topics: collectTopics(),
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
      closeDrill();
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
    elements['historybot-browse'].hidden = !state.canDrill;
    renderDrill();
  }

  function ensureChart() {
    if (!window.echarts) throw new Error('The local chart library is unavailable. Restart Split and try again.');
    if (state.chart) return;
    state.chart = window.echarts.init(elements['historybot-chart'], null, { renderer: 'canvas' });
    state.chart.on('click', params => {
      if (state.view !== 'calendar' || params.componentType !== 'series' || !state.canDrill) return;
      const day = params.value[0];
      openDrill({ topicId: state.calendarTopicId, start: day, end: day, label: day });
    });
    state.chart.getZr().on('click', event => {
      if (state.view === 'frequency' && state.canDrill) drillFromFrequency([event.offsetX, event.offsetY]);
    });
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

  function titleWidth() {
    return Math.max(240, elements['historybot-chart'].clientWidth - 48);
  }

  function resolvedGranularity() {
    return state.granularity === 'auto' ? state.response.meta.recommendedGranularity : state.granularity;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function clickHint() {
    return state.canDrill ? ' Click the chart to list its conversations.' : '';
  }

  function plural(count, noun) {
    return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
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
        textStyle: { color: '#D8E2EA', fontFamily: 'Georgia', fontSize: 20, fontWeight: 400, width: titleWidth(), overflow: 'truncate' },
        subtextStyle: { color: '#8E9AA5', fontSize: 11 },
      },
      legend: { top: 62, left: 12, right: 12, textStyle: { color: '#D8E2EA' }, type: 'scroll' },
      grid: { left: 54, right: 24, top: 108, bottom: useZoom ? 72 : 42, containLabel: true },
      tooltip: {
        id: 'toolTip',
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
    elements['historybot-summary'].textContent = `${total.toLocaleString()} ${MEASURE_LABELS[state.measure].toLowerCase()} across ${state.response.series.length} series.${clickHint()}`;
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
        textStyle: { color: '#D8E2EA', fontFamily: 'Georgia', fontSize: 20, fontWeight: 400, width: titleWidth(), overflow: 'truncate' },
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
    elements['historybot-summary'].textContent = `${total.toLocaleString()} ${MEASURE_LABELS[state.measure].toLowerCase()} for ${series.label} in ${state.calendarYear}.${clickHint()}`;
    elements['historybot-chart'].setAttribute('aria-label', `Calendar for ${series.label} in ${state.calendarYear}. Total ${total} ${MEASURE_LABELS[state.measure].toLowerCase()}.`);
  }

  function renderEmptyState(message) {
    state.chart?.clear();
    elements['historybot-chart'].hidden = true;
    elements['historybot-empty'].hidden = false;
    elements['historybot-empty'].textContent = message;
    elements['historybot-summary'].textContent = '';
    elements['historybot-save-png'].disabled = true;
    elements['historybot-browse'].hidden = true;
    closeDrill();
  }

  function renderError(message) {
    elements['historybot-error'].textContent = message || '';
    if (message) elements['historybot-status'].textContent = message;
  }

  // ---- Drill-down: the conversations behind a clicked bucket or the whole range ----

  // Inclusive date window of one bucket, clamped to the applied range.
  function bucketWindow(start, granularity) {
    const applied = state.response.meta.appliedRange;
    const date = new Date(`${start}T00:00:00Z`);
    if (granularity === 'day') date.setUTCDate(date.getUTCDate() + 1);
    if (granularity === 'week') date.setUTCDate(date.getUTCDate() + 7);
    if (granularity === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
    if (granularity === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
    date.setUTCDate(date.getUTCDate() - 1);
    const end = date.toISOString().slice(0, 10);
    const labels = { day: start, week: `Week of ${start}`, month: start.slice(0, 7), year: start.slice(0, 4) };
    return { start: start > applied.start ? start : applied.start, end: end < applied.end ? end : applied.end, label: labels[granularity] };
  }

  // Nearest bucket to a click anywhere in the plot area; lines are too thin to hit directly.
  function drillFromFrequency(point) {
    if (!state.response?.meta.appliedRange || !state.chart.containPixel('grid', point)) return;
    const granularity = resolvedGranularity();
    let best = null;
    let bestDistance = Infinity;
    for (const bucket of state.response.series[0].buckets[granularity]) {
      const distance = Math.abs(state.chart.convertToPixel({ xAxisIndex: 0 }, bucket.start) - point[0]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = bucket;
      }
    }
    if (best) openDrill({ topicId: state.drill?.topicId || state.response.series[0].id, ...bucketWindow(best.start, granularity) });
  }

  function browseAll() {
    const applied = state.response?.meta.appliedRange;
    if (!applied) return;
    if (state.view === 'calendar') {
      const [start, end] = calendarRange();
      return openDrill({ topicId: state.calendarTopicId, start, end, label: String(state.calendarYear) });
    }
    openDrill({ topicId: state.drill?.topicId || state.response.series[0].id, start: applied.start, end: applied.end, label: `${applied.start} to ${applied.end}` });
  }

  async function openDrill(target) {
    const response = state.response;
    if (!response?.meta.appliedRange) return;
    const topic = response.query.topics.find(item => item.id === target.topicId) || response.query.topics[0];
    state.drill?.controller?.abort();
    const controller = new AbortController();
    state.drill = { ...target, topicId: topic.id, topic, response: null, results: null, error: '', controller };
    renderDrill();
    elements['historybot-drilldown'].scrollIntoView({ block: 'nearest', behavior: state.reducedMotion ? 'auto' : 'smooth' });
    try {
      const result = await fetch('/api/historybot/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: response.query.isAllActivity ? null : { terms: topic.terms },
          roles: response.query.roles,
          dateRange: { start: target.start, end: target.end },
        }),
        signal: controller.signal,
      });
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(payload.error?.message || 'Historybot could not list these conversations.');
      if (state.drill?.controller !== controller) return;
      state.drill.response = payload;
    } catch (error) {
      if (error.name === 'AbortError' || state.drill?.controller !== controller) return;
      state.drill.error = error.message;
    }
    renderDrill();
  }

  function closeDrill() {
    state.drill?.controller?.abort();
    state.drill = null;
    renderDrill();
  }

  function setDrillNote(text) {
    elements['historybot-drilldown-note'].textContent = text;
  }

  function renderDrillTopics() {
    const wrap = elements['historybot-drilldown-topics'];
    wrap.replaceChildren();
    const topics = state.response.query.topics;
    wrap.hidden = topics.length <= 1;
    topics.forEach((topic, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'historybot-chip';
      chip.textContent = topic.label;
      chip.title = topic.label;
      chip.style.setProperty('--chip-color', TOPIC_COLORS[index]);
      chip.setAttribute('aria-pressed', String(topic.id === state.drill.topicId));
      chip.addEventListener('click', () => {
        const drill = state.drill;
        if (drill && topic.id !== drill.topicId) openDrill({ topicId: topic.id, start: drill.start, end: drill.end, label: drill.label });
      });
      wrap.append(chip);
    });
  }

  function renderDrillEntry(entry, isAllActivity) {
    const item = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'historybot-conv';
    const title = document.createElement('span');
    title.className = 'historybot-conv-title';
    title.textContent = entry.title || entry.file || `Conversation ${entry.conversation}`;
    const meta = document.createElement('span');
    meta.className = 'historybot-conv-meta';
    const when = entry.firstMatchDate === entry.lastMatchDate ? entry.firstMatchDate : `${entry.firstMatchDate} to ${entry.lastMatchDate}`;
    meta.textContent = isAllActivity
      ? `${when} · ${plural(entry.messages, 'message')}`
      : `${when} · ${plural(entry.messages, 'message')} · ${plural(entry.mentions, 'mention')}`;
    open.append(title, meta);
    open.addEventListener('click', () => openInViewer(entry));
    const drawer = document.createElement('button');
    drawer.type = 'button';
    drawer.className = 'historybot-conv-drawer';
    drawer.title = 'Open in slideout drawer';
    drawer.setAttribute('aria-label', `Open ${title.textContent} in a slideout drawer`);
    drawer.textContent = '⇱';
    drawer.addEventListener('click', () => openInDrawer(entry));
    item.append(open, drawer);
    return item;
  }

  function renderDrill() {
    const panel = elements['historybot-drilldown'];
    const drill = state.drill;
    panel.hidden = !drill;
    if (!drill) return;
    const response = drill.response;
    elements['historybot-drilldown-title'].textContent = drill.label;
    const prefix = `${drill.topic.label} · ${roleLabel()}`;
    elements['historybot-drilldown-meta'].textContent = response
      ? `${prefix} · ${plural(response.meta.totalConversations, 'conversation')} · ${plural(response.meta.totalMessages, 'message')}${response.query.isAllActivity ? '' : ` · ${plural(response.meta.totalMentions, 'mention')}`}`
      : prefix;
    renderDrillTopics();
    elements['historybot-drilldown-list'].replaceChildren();
    panel.setAttribute('aria-busy', String(!response && !drill.error));
    if (drill.error) return setDrillNote(drill.error);
    if (!response) return setDrillNote('Finding conversations…');
    if (!response.conversations.length) return setDrillNote('No conversations match in this interval.');
    setDrillNote(response.meta.returned < response.meta.totalConversations
      ? `Showing the ${response.meta.returned} busiest of ${response.meta.totalConversations.toLocaleString()} conversations. Narrow the interval to see the rest.`
      : 'Select a conversation to open it in the viewer with its matches highlighted.');
    response.conversations.forEach(entry => elements['historybot-drilldown-list'].append(renderDrillEntry(entry, response.query.isAllActivity)));
  }

  // ---- Hand-off to the viewer in index.html (showSearchResults, buildConversationMatches, openDrawer) ----

  function viewerAvailable() {
    return typeof window.showSearchResults === 'function' && typeof window.buildConversationMatches === 'function';
  }

  async function fetchConversation(entry) {
    const response = await fetch(`/${entry.file}`);
    if (!response.ok) throw new Error(`Could not load ${entry.file}.`);
    const data = await response.json();
    const list = Array.isArray(data) ? data : [data];
    return list[entry.indexInFile ?? 0] || list[0] || null;
  }

  // Search-bar style groups from a topic's terms; null for All activity (every message counts).
  function highlightGroups(topic) {
    if (!topic.terms?.length) return null;
    const groups = [{ includeTerms: [], excludeTerms: [] }];
    topic.terms.forEach((term, index) => {
      if (term.operator === 'OR' && index > 0) groups.push({ includeTerms: [], excludeTerms: [] });
      (term.operator === 'WITHOUT' ? groups.at(-1).excludeTerms : groups.at(-1).includeTerms).push(term.value.toLowerCase());
    });
    return groups;
  }

  function localDateFormatter(timeZone) {
    let formatter;
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    return seconds => {
      if (!Number.isFinite(seconds)) return null;
      const parts = Object.fromEntries(formatter.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
  }

  // Only the messages the statistic counted: selected roles, dated inside the window (same fallback as the index).
  function messageAcceptor(drill) {
    const roles = new Set(drill.response.query.roles);
    const range = drill.response.meta.appliedRange || drill;
    const toLocalDate = localDateFormatter(state.response.meta.timezone);
    return (message, conversation) => {
      if (!roles.has(message.author?.role)) return false;
      const date = toLocalDate(Number.isFinite(message.create_time) ? message.create_time : conversation.create_time);
      return Boolean(date) && date >= range.start && date <= range.end;
    };
  }

  async function loadDrillResults(drill) {
    if (drill.results) return drill.results;
    const groups = highlightGroups(drill.topic);
    const accept = messageAcceptor(drill);
    const results = await Promise.all(drill.response.conversations.map(async entry => {
      try {
        const conversation = await fetchConversation(entry);
        if (!conversation) return null;
        const matches = window.buildConversationMatches(conversation, groups, message => accept(message, conversation));
        return {
          file: entry.file,
          indexInFile: entry.indexInFile,
          title: conversation.title || entry.title || entry.file,
          conversation,
          matches,
          fullData: conversation,
          create_time: conversation.create_time || null,
        };
      } catch (error) {
        console.error('Historybot could not load', entry.file, error);
        return null;
      }
    }));
    drill.results = results.filter(Boolean);
    return drill.results;
  }

  async function openInViewer(entry) {
    const drill = state.drill;
    if (!drill?.response) return;
    if (!viewerAvailable()) return setDrillNote('The conversation viewer is unavailable on this page.');
    setDrillNote('Loading conversations into the viewer…');
    const results = await loadDrillResults(drill);
    if (state.drill !== drill) return;
    if (!results.length) return setDrillNote('None of these conversations could be loaded.');
    const shown = window.showSearchResults(results, drill.topic.label);
    const index = shown.findIndex(result => result.file === entry.file && result.indexInFile === entry.indexInFile);
    if (index > 0 && typeof window.selectConversationByIndex === 'function') window.selectConversationByIndex(index);
    setDrillNote('Opened in the viewer. Use the search arrows to step through matches; reopen Historybot from the main image.');
    closeHistorybot();
  }

  async function openInDrawer(entry) {
    if (typeof window.openDrawer !== 'function') return setDrillNote('The slideout drawer is unavailable on this page.');
    try {
      const conversation = await fetchConversation(entry);
      if (!conversation) throw new Error('That conversation is missing from its file.');
      window.openDrawer(conversation, conversation.title || entry.title);
      closeHistorybot();
    } catch (error) {
      setDrillNote(error.message);
    }
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
      state.canDrill = Boolean(payload.messageSearch);
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
    elements['historybot-browse'].addEventListener('click', browseAll);
    elements['historybot-drilldown-close'].addEventListener('click', closeDrill);
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
