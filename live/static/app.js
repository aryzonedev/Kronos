/* Kronos live chart: KLineChart + live candles + Kronos forecast overlay. */
(() => {
  'use strict';

  const CANDLE_PANE = 'candle_pane';
  const MAIN_PANE_INDICATORS = new Set(['MA', 'EMA', 'BOLL']);
  const CRYPTO_POLL_MS = 5000;
  // Forex: Twelve Data's free plan has per-minute and daily request limits.
  const FOREX_MIN_POLL_MS = 2 * 60 * 1000;
  const SLOW_POLL_MS = 15 * 60 * 1000;          // long intervals and closed markets
  const CANDLES_TIMEOUT_MS = 20 * 1000;
  const FORECAST_TIMEOUT_MS = 5 * 60 * 1000;    // the first run of a model may download it
  const PREFETCH_MAX_AGE_MS = 15 * 1000;
  const DEFAULT_RIGHT_OFFSET_PX = 80;
  const DRAWINGS_GROUP = 'drawings';
  const FORECAST_GROUP = 'kronos';
  const STORAGE_KEY = 'kronos-live-selection';
  const RUNNING_TEXT = 'Running Kronos…';
  const CANDLE = { up: '#089981', down: '#f23645', flat: '#787b86' };
  const FORECAST = {
    up: '#5b8def',
    down: '#b07cf2',
    upFill: 'rgba(91, 141, 239, 0.28)',
    downFill: 'rgba(176, 124, 242, 0.28)',
    line: '#f5c542',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    market: $('market'),
    symbol: $('symbol'),
    symbolList: $('symbol-list'),
    intervals: $('intervals'),
    model: $('model'),
    predLen: $('pred-len'),
    samples: $('samples'),
    runForecast: $('run-forecast'),
    autoForecast: $('auto-forecast'),
    clearForecast: $('clear-forecast'),
    clearDrawings: $('clear-drawings'),
    volume: document.querySelector('.indicator[data-name="VOL"]'),
    status: $('status'),
    notice: $('notice'),
    forecastStatus: $('forecast-status'),
    hint: $('hint'),
    chart: $('chart'),
  };

  const state = {
    config: null,
    loaded: null,         // { market, symbol, interval } the chart shows
    pending: null,        // selection being loaded, if any
    pricePrecision: 2,
    chartSymbol: null,    // "ticker|precision" set on the chart
    chartInterval: null,  // interval key set on the chart
    chartDataKey: null,   // selection whose candles the chart holds
    selectionId: 0,       // bumped on every market/symbol/interval change
    prefetched: null,     // { selectionId, at, data } candles loaded while switching
    pollLoopId: 0,        // bumped to stop the running poll loop
    pollTimer: null,
    barCallback: null,    // KLineChart's callback for live candle updates
    lastClosedTs: null,
    forecasting: false,
    forecastRunId: 0,     // bumped by Clear / chart changes so late results are dropped
    forecast: null,       // { firstTs, count, min, max } of the drawn forecast
    zoomBeforeForecast: null,   // { before, after } bar space when a forecast zoomed out
    wantVolume: true,     // the user's VOL choice, kept across markets without volume
  };

  let chart = null;

  // ---------- helpers ----------

  async function api(path, { timeoutMs = CANDLES_TIMEOUT_MS, ...options } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(path, { ...options, signal: controller.signal });
      let body = null;
      try {
        body = await resp.json();
      } catch (err) {
        if (err.name === 'AbortError') throw err;   // otherwise: not JSON, handled below
      }
      if (!resp.ok) throw new Error((body && body.error) || `HTTP ${resp.status}`);
      if (body === null) throw new Error('unexpected response from the server');
      return body;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`no answer after ${Math.round(timeoutMs / 1000)}s`);
      if (err instanceof TypeError) throw new Error('cannot reach the Kronos server');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function setText(el, text, kind) {
    el.textContent = text;
    el.className = kind || '';
  }

  function formatPrice(value) {
    return Number(value).toFixed(state.pricePrecision);
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function intervalInfo(key) {
    return state.config.intervals.find((i) => i.key === key);
  }

  function selectionKey(sel) {
    return sel ? `${sel.market}|${sel.symbol}|${sel.interval}` : null;
  }

  function candlesUrl(sel, limit) {
    const query = new URLSearchParams({
      market: sel.market, symbol: sel.symbol, interval: sel.interval, limit: String(limit),
    });
    return `/api/candles?${query}`;
  }

  function toBar(c) {
    return { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
  }

  function latestClosedTimestamp(candles) {
    for (let i = candles.length - 1; i >= 0; i -= 1) {
      if (candles[i].closed) return candles[i].timestamp;
    }
    return null;
  }

  // No new candle for a while: the market is probably closed (forex at the weekend).
  function looksClosed(lastTimestamp) {
    if (lastTimestamp === null || !state.loaded) return false;
    const step = intervalInfo(state.loaded.interval).step_ms;
    return Date.now() - lastTimestamp > 2 * step + 10 * 60 * 1000;
  }

  function addOptions(select, items) {
    items.forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = label;
      select.appendChild(option);
    });
  }

  function setPressed(button, on) {
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }

  function saveSelection() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.loaded));
    } catch (_) {
      // storage unavailable (private mode etc.): not important
    }
  }

  function loadSavedSelection() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && state.config.markets[saved.market] && intervalInfo(saved.interval)
          && typeof saved.symbol === 'string' && saved.symbol) {
        return { market: saved.market, symbol: saved.symbol, interval: saved.interval };
      }
    } catch (_) {
      // ignore broken or unavailable storage
    }
    return null;
  }

  // ---------- forecast overlay ----------

  function registerForecastOverlay() {
    klinecharts.registerOverlay({
      name: 'kronosForecast',
      lock: true,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: ({ chart: c, overlay, coordinates, yAxis }) => {
        const candles = (overlay.extendData && overlay.extendData.candles) || [];
        if (!yAxis || candles.length === 0 || coordinates.length !== candles.length) return [];
        const half = Math.max(1, Math.floor(c.getBarSpace().gapBar / 2));
        const figures = [];
        let top = Infinity;
        candles.forEach((k, i) => {
          const x = coordinates[i].x;
          const yOpen = yAxis.convertToPixel(k.open);
          const yClose = yAxis.convertToPixel(k.close);
          // Model output can put high/low inside the body; draw the wick around it anyway.
          const yHigh = yAxis.convertToPixel(Math.max(k.high, k.open, k.close));
          const yLow = yAxis.convertToPixel(Math.min(k.low, k.open, k.close));
          const up = k.close >= k.open;
          const color = up ? FORECAST.up : FORECAST.down;
          top = Math.min(top, yHigh);
          figures.push({
            type: 'line',
            attrs: { coordinates: [{ x, y: yHigh }, { x, y: yLow }] },
            styles: { style: 'solid', size: 1, color },
            ignoreEvent: true,
          });
          figures.push({
            type: 'rect',
            attrs: {
              x: x - half,
              y: Math.min(yOpen, yClose),
              width: half * 2,
              height: Math.max(1, Math.abs(yOpen - yClose)),
            },
            styles: { style: 'stroke_fill', color: up ? FORECAST.upFill : FORECAST.downFill, borderColor: color, borderSize: 1 },
            ignoreEvent: true,
          });
        });
        figures.push({
          type: 'line',
          attrs: { coordinates: coordinates.map((p) => ({ x: p.x, y: p.y })) },
          styles: { style: 'dashed', size: 1, color: FORECAST.line, dashedValue: [4, 3] },
          ignoreEvent: true,
        });
        figures.push({
          type: 'text',
          attrs: { x: coordinates[0].x, y: top - 6, text: 'Kronos forecast', align: 'left', baseline: 'bottom' },
          styles: {
            style: 'fill', color: FORECAST.line, size: 11, backgroundColor: 'transparent', borderSize: 0,
            paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
          },
          ignoreEvent: true,
        });
        return figures;
      },
    });
  }

  // Price-axis hook: widen the range to include the forecast while it is on screen
  // (overlays are not part of KLineChart's own range calculation).
  function includeForecastInRange({ defaultRange }) {
    const fc = state.forecast;
    const list = chart ? chart.getDataList() : [];
    if (!fc || !state.loaded || list.length === 0) return defaultRange;
    const lastIndex = list.length - 1;
    const stepMs = intervalInfo(state.loaded.interval).step_ms;
    const firstIndex = lastIndex + Math.round((fc.firstTs - list[lastIndex].timestamp) / stepMs);
    const { realFrom, realTo } = chart.getVisibleRange();
    if (firstIndex + fc.count - 1 < realFrom || firstIndex >= realTo) return defaultRange;
    const from = Math.min(defaultRange.from, fc.min);
    const to = Math.max(defaultRange.to, fc.max);
    if (from === defaultRange.from && to === defaultRange.to) return defaultRange;
    const span = to - from;
    return {
      ...defaultRange,
      from, to, range: span,
      realFrom: from, realTo: to, realRange: span,
      displayFrom: from, displayTo: to, displayRange: span,
    };
  }

  function refreshPriceAxis() {
    chart.overrideYAxis({ paneId: CANDLE_PANE, createRange: includeForecastInRange });
  }

  function drawForecast(result) {
    const candles = result.candles;
    state.forecast = {
      firstTs: candles[0].timestamp,
      count: candles.length,
      min: Math.min(...candles.map((c) => Math.min(c.low, c.open, c.close))),
      max: Math.max(...candles.map((c) => Math.max(c.high, c.open, c.close))),
    };
    chart.removeOverlay({ groupId: FORECAST_GROUP });
    chart.createOverlay({
      name: 'kronosForecast',
      groupId: FORECAST_GROUP,
      points: candles.map((c) => ({ timestamp: c.timestamp, value: c.close })),
      extendData: { candles },
    });
    // Leave room on the right so the forecast fits in about half of the chart.
    const slots = candles.length + 4;
    const maxRoom = els.chart.clientWidth * 0.5;
    const current = chart.getBarSpace().bar;
    let barSpace = current;
    if (slots * current > maxRoom) {
      chart.setBarSpace(Math.max(2, maxRoom / slots));
      barSpace = chart.getBarSpace().bar;
      state.zoomBeforeForecast = { before: state.zoomBeforeForecast?.before ?? current, after: barSpace };
    }
    chart.setOffsetRightDistance(slots * barSpace);
    chart.scrollToRealTime(300);
    refreshPriceAxis();
  }

  function clearForecast() {
    state.forecastRunId += 1;   // a forecast that is still running will not be drawn
    setText(els.forecastStatus, '');
    if (!chart || state.forecast === null) return;
    state.forecast = null;
    chart.removeOverlay({ groupId: FORECAST_GROUP });
    const zoom = state.zoomBeforeForecast;
    state.zoomBeforeForecast = null;
    // Undo the forecast's zoom-out, unless the user has zoomed since.
    if (zoom && chart.getBarSpace().bar === zoom.after) chart.setBarSpace(zoom.before);
    chart.setOffsetRightDistance(DEFAULT_RIGHT_OFFSET_PX);
    refreshPriceAxis();
  }

  function updateForecastButton() {
    els.runForecast.disabled = state.forecasting || state.loaded === null || state.pending !== null;
  }

  function describeForecast(r) {
    const change = (r.forecast_close / r.last_close - 1) * 100;
    const loading = r.model_load_s >= 0.5 ? ` (+${r.model_load_s}s loading the model)` : '';
    return `${r.model} on ${r.device} · ${r.took_s}s${loading} · ${r.history_candles} candles in`
      + ` · last close ${formatPrice(r.last_close)} at ${formatTime(r.last_close_time)}`
      + ` → ${formatPrice(r.forecast_close)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)`
      + ` after ${r.candles.length} candles`;
  }

  async function runForecast() {
    const sel = state.loaded;
    if (state.forecasting || sel === null || state.pending !== null) return;
    const selectionId = state.selectionId;
    const runId = ++state.forecastRunId;
    const isStale = () => selectionId !== state.selectionId || runId !== state.forecastRunId;
    state.forecasting = true;
    updateForecastButton();
    setText(els.forecastStatus, RUNNING_TEXT);
    try {
      const result = await api('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market: sel.market,
          symbol: sel.symbol,
          interval: sel.interval,
          model: els.model.value,
          pred_len: Number(els.predLen.value),
          sample_count: Number(els.samples.value),
        }),
        timeoutMs: FORECAST_TIMEOUT_MS,
      });
      if (!isStale()) {
        drawForecast(result);
        setText(els.forecastStatus, describeForecast(result));
      }
    } catch (err) {
      if (!isStale()) setText(els.forecastStatus, `Forecast failed: ${err.message}`, 'error');
    } finally {
      state.forecasting = false;
      updateForecastButton();
      if (isStale() && els.forecastStatus.textContent === RUNNING_TEXT) setText(els.forecastStatus, '');
    }
  }

  // ---------- live data (KLineChart data loader) ----------

  function onCandles(data) {
    const closedTs = latestClosedTimestamp(data.candles);
    const newCandleClosed = closedTs !== null && state.lastClosedTs !== null && closedTs > state.lastClosedTs;
    if (closedTs !== null && (state.lastClosedTs === null || closedTs > state.lastClosedTs)) {
      state.lastClosedTs = closedTs;
    }
    const lastTs = data.candles.length > 0 ? data.candles[data.candles.length - 1].timestamp : null;
    if (looksClosed(lastTs)) {
      setText(els.status, `◌ ${data.symbol} ${data.interval} · no new candles since ${formatTime(lastTs)} (market closed?)`);
    } else {
      setText(els.status, `● Live · ${data.symbol} ${data.interval} · updated ${new Date().toLocaleTimeString()}`, 'ok');
    }
    if (newCandleClosed && els.autoForecast.checked) runForecast();
  }

  function deliverBars(callback, sel, bars) {
    state.chartDataKey = selectionKey(sel);
    callback(bars, false);
  }

  async function getBars({ type, callback }) {
    if (type !== 'init') {   // no paging into older history
      callback([], false);
      return;
    }
    const selectionId = state.selectionId;
    const sel = state.loaded;
    const pre = state.prefetched;
    if (pre && pre.selectionId === selectionId && Date.now() - pre.at < PREFETCH_MAX_AGE_MS) {
      deliverBars(callback, sel, pre.data.candles.map(toBar));
      return;
    }
    // If this reload fails, keep the candles already on screen (the poll retries).
    const keep = state.chartDataKey === selectionKey(sel) ? chart.getDataList().slice() : [];
    try {
      const data = await api(candlesUrl(sel, state.config.chart_candles));
      if (selectionId !== state.selectionId) return;   // a newer load is already running
      deliverBars(callback, sel, data.candles.map(toBar));
      onCandles(data);
    } catch (err) {
      if (selectionId !== state.selectionId) return;
      setText(els.status, `Load failed: ${err.message} (retrying)`, 'error');
      deliverBars(callback, sel, keep);
    }
  }

  function stopPolling() {
    state.pollLoopId += 1;
    if (state.pollTimer !== null) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function pollDelayMs() {
    const sel = state.loaded;
    if (!sel || sel.market === 'crypto') return CRYPTO_POLL_MS;
    const list = chart.getDataList();
    const last = list.length > 0 ? list[list.length - 1].timestamp : null;
    if (looksClosed(last)) return SLOW_POLL_MS;
    return Math.min(SLOW_POLL_MS, Math.max(FOREX_MIN_POLL_MS, intervalInfo(sel.interval).step_ms / 5));
  }

  function startPolling() {
    stopPolling();
    const loopId = state.pollLoopId;
    const sel = state.loaded;
    const callback = state.barCallback;
    if (!sel || !callback) return;
    const poll = async () => {
      if (loopId !== state.pollLoopId) return;
      if (!document.hidden) {
        try {
          const data = await api(candlesUrl(sel, 3));
          if (loopId !== state.pollLoopId) return;
          const list = chart.getDataList();
          const last = list[list.length - 1];
          if (!last || (data.candles.length > 0 && data.candles[0].timestamp > last.timestamp)) {
            // Empty chart (an earlier load failed) or missed candles (e.g. the computer
            // slept): reload everything. This stops this loop; a new one starts after loading.
            state.prefetched = null;
            chart.resetData();
            return;
          }
          data.candles.forEach((c) => callback(toBar(c)));
          onCandles(data);
        } catch (err) {
          if (loopId !== state.pollLoopId) return;
          setText(els.status, `Update failed: ${err.message}`, 'error');
        }
      }
      if (loopId === state.pollLoopId) state.pollTimer = setTimeout(poll, pollDelayMs());
    };
    state.pollTimer = setTimeout(poll, pollDelayMs());
  }

  function subscribeBar({ callback }) {
    state.barCallback = callback;
    startPolling();
  }

  // ---------- selection (market / symbol / interval) ----------

  function renderSelection(sel) {
    const market = state.config.markets[sel.market];
    els.market.value = sel.market;
    els.symbol.value = sel.symbol;
    els.symbolList.replaceChildren(...market.symbols.map((s) => {
      const option = document.createElement('option');
      option.value = s;
      return option;
    }));
    els.intervals.querySelectorAll('button').forEach((b) => setPressed(b, b.dataset.key === sel.interval));
    const needsKey = sel.market === 'forex' && !state.config.forex_key_configured;
    setText(els.hint, needsKey ? 'Forex uses the Twelve Data demo key (EUR/USD only). See live/README.md to add your own key.' : '');
  }

  function syncVolumeIndicator() {
    const hasVolume = state.config.markets[state.loaded.market].has_volume;
    els.volume.disabled = !hasVolume;
    els.volume.title = hasVolume ? '' : 'No volume data for this market';
    setIndicator(els.volume, hasVolume && state.wantVolume);
  }

  async function applySelection(next) {
    const selectionId = ++state.selectionId;
    stopPolling();   // never push new-symbol candles into the old chart
    state.pending = next;
    updateForecastButton();
    renderSelection(next);
    setText(els.status, `Loading ${next.symbol} ${next.interval}…`);
    try {
      const data = await api(candlesUrl(next, state.config.chart_candles));
      if (selectionId !== state.selectionId) return false;
      const loaded = { market: next.market, symbol: data.symbol, interval: next.interval };
      const symbolChanged = state.loaded === null
        || state.loaded.market !== loaded.market || state.loaded.symbol !== loaded.symbol;
      state.pending = null;
      state.loaded = loaded;
      state.lastClosedTs = null;
      state.prefetched = { selectionId, at: Date.now(), data };
      state.pricePrecision = data.price_precision;
      setText(els.notice, '');
      clearForecast();
      if (symbolChanged) chart.removeOverlay({ groupId: DRAWINGS_GROUP });
      renderSelection(loaded);
      const symbolKey = `${data.symbol}|${data.price_precision}`;
      let reloaded = false;
      if (symbolKey !== state.chartSymbol) {
        state.chartSymbol = symbolKey;
        chart.setSymbol({ ticker: data.symbol, pricePrecision: data.price_precision, volumePrecision: 2 });
        reloaded = true;
      }
      if (loaded.interval !== state.chartInterval) {
        state.chartInterval = loaded.interval;
        chart.setPeriod(intervalInfo(loaded.interval).period);
        reloaded = true;
      }
      if (!reloaded) chart.resetData();
      syncVolumeIndicator();
      onCandles(data);
      saveSelection();
      updateForecastButton();
      return true;
    } catch (err) {
      if (selectionId !== state.selectionId) return false;
      state.pending = null;
      updateForecastButton();
      setText(els.notice, `Could not load ${next.symbol} ${next.interval}: ${err.message}`, 'error');
      if (state.loaded !== null) {
        // The chart was not touched: show its selection again and resume its live updates.
        renderSelection(state.loaded);
        setText(els.status, `${state.loaded.symbol} ${state.loaded.interval} · live updates resumed`);
        startPolling();
      } else {
        setText(els.status, '');
      }
      return false;
    }
  }

  // ---------- indicators and drawing tools ----------

  function setIndicator(button, on) {
    const name = button.dataset.name;
    const onMainPane = MAIN_PANE_INDICATORS.has(name);
    const paneId = onMainPane ? CANDLE_PANE : `pane_${name}`;
    const active = button.classList.contains('active');
    if (on && !active) {
      if (chart.createIndicator({ name, paneId }, onMainPane)) setPressed(button, true);
    } else if (!on && active) {
      chart.removeIndicator({ name, paneId });
      setPressed(button, false);
    }
  }

  // ---------- setup ----------

  function createChart() {
    chart = klinecharts.init(els.chart, {
      styles: 'dark',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (!chart) throw new Error('KLineChart could not start');
    chart.setStyles({
      candle: {
        bar: {
          upColor: CANDLE.up,
          downColor: CANDLE.down,
          noChangeColor: CANDLE.flat,
          upBorderColor: CANDLE.up,
          downBorderColor: CANDLE.down,
          noChangeBorderColor: CANDLE.flat,
          upWickColor: CANDLE.up,
          downWickColor: CANDLE.down,
          noChangeWickColor: CANDLE.flat,
        },
      },
    });
    // Show 0.00005 as is, not KLineChart's folded "0.0{4}5".
    chart.setDecimalFold({ format: (value) => String(value) });
    chart.setDataLoader({ getBars, subscribeBar, unsubscribeBar: stopPolling });
    refreshPriceAxis();
    // KLineChart follows the container size itself (ResizeObserver).
  }

  function buildControls() {
    const cfg = state.config;
    addOptions(els.market, Object.entries(cfg.markets).map(([value, m]) => ({ value, label: m.label })));
    cfg.intervals.forEach((i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = i.key;
      button.dataset.key = i.key;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        const current = state.pending || state.loaded;
        if (current && i.key !== current.interval) {
          applySelection({ market: current.market, symbol: current.symbol, interval: i.key });
        }
      });
      els.intervals.appendChild(button);
    });
    addOptions(els.model, cfg.models.map((m) => ({ value: m.key, label: m.name })));
    els.model.value = cfg.default_model;
    addOptions(els.predLen, cfg.pred_len_choices.map((n) => ({ value: n, label: `${n} candles` })));
    els.predLen.value = String(cfg.pred_len_choices.includes(48) ? 48 : cfg.pred_len_choices[0]);
    addOptions(els.samples, cfg.sample_count_choices.map((n) => ({ value: n, label: `${n} sample${n > 1 ? 's' : ''}` })));
    els.samples.value = String(cfg.default_sample_count);

    els.market.addEventListener('change', () => {
      const market = els.market.value;
      const current = state.pending || state.loaded;
      applySelection({ market, symbol: cfg.markets[market].symbols[0], interval: current ? current.interval : '5m' });
    });
    const applySymbolInput = () => {
      const current = state.pending || state.loaded;
      const symbol = els.symbol.value.trim().toUpperCase();
      if (!current) return;
      if (!symbol) {
        els.symbol.value = current.symbol;
      } else if (symbol !== current.symbol) {
        applySelection({ market: current.market, symbol, interval: current.interval });
      }
    };
    // The browser's list only shows entries matching the text in the box, so the box is
    // emptied while focused to show every symbol (the current one stays as a hint).
    els.symbol.addEventListener('focus', () => {
      els.symbol.placeholder = els.symbol.value;
      els.symbol.value = '';
    });
    els.symbol.addEventListener('blur', () => {
      if (!els.symbol.value.trim()) {
        const current = state.pending || state.loaded;
        els.symbol.value = current ? current.symbol : els.symbol.placeholder;
      }
    });
    // Picking an entry from the list loads it at once; typed symbols load on Enter.
    els.symbol.addEventListener('input', () => {
      const current = state.pending || state.loaded;
      const value = els.symbol.value.trim().toUpperCase();
      if (current && state.config.markets[current.market].symbols.includes(value)) applySymbolInput();
    });
    els.symbol.addEventListener('change', applySymbolInput);
    document.querySelectorAll('.indicator').forEach((b) => b.addEventListener('click', () => {
      const on = !b.classList.contains('active');
      if (b === els.volume) state.wantVolume = on;
      setIndicator(b, on);
    }));
    document.querySelectorAll('.draw').forEach((b) => b.addEventListener('click', () => {
      chart.createOverlay({ name: b.dataset.name, groupId: DRAWINGS_GROUP });
    }));
    els.clearDrawings.addEventListener('click', () => chart.removeOverlay({ groupId: DRAWINGS_GROUP }));
    els.runForecast.addEventListener('click', runForecast);
    els.clearForecast.addEventListener('click', clearForecast);
    els.autoForecast.addEventListener('change', () => {
      if (els.autoForecast.checked) runForecast();
    });
  }

  async function main() {
    updateForecastButton();
    if (typeof klinecharts === 'undefined') {
      setText(els.status, 'Could not load KLineChart. Check your internet connection and reload.', 'error');
      return;
    }
    try {
      state.config = await api('/api/config');
    } catch (err) {
      setText(els.status, `Could not reach the Kronos server: ${err.message}`, 'error');
      return;
    }
    registerForecastOverlay();
    createChart();
    buildControls();
    const fallback = { market: 'crypto', symbol: state.config.markets.crypto.symbols[0], interval: '5m' };
    const saved = loadSavedSelection();
    if (await applySelection(saved || fallback)) return;
    if (saved && state.loaded === null && selectionKey(saved) !== selectionKey(fallback)) {
      // The saved chart can't be loaded (e.g. a forex pair without an API key): use the default.
      const reason = els.notice.textContent;
      if (await applySelection(fallback)) setText(els.notice, reason, 'error');
    }
  }

  main();
})();
