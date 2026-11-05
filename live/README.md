# Kronos Live Chart

A live candlestick chart ([KLineChart](https://github.com/klinecharts/KLineChart) 10.1.0) that loads
market data straight from an API, with no CSV files, and draws Kronos forecasts on top of it.

- **Crypto:** Binance public API. No key needed.
- **Forex:** Twelve Data API. Works with the public `demo` key for EUR/USD; other pairs need your own free key.

The files of the existing `webui/` (port 7070) are not changed. One fix in `model/kronos.py`
(`KronosPredictor` now switches the model to inference mode with `.eval()`) also applies to `webui/`
and the examples: their forecasts no longer have random dropout noise, so they can differ slightly
from before.

## Run

From the `Kronos` folder (it uses the same `.venv` as the rest of the project; Flask, pandas and
requests are already installed there):

```bash
.venv/bin/python live/app.py
```

Open http://127.0.0.1:7071. The server only listens on this computer, only answers requests
addressed to `127.0.0.1`/`localhost`, and runs with the debugger off. Stop it with `Ctrl+C`.
To use another port, set `KRONOS_LIVE_PORT`. After editing `templates/index.html`, restart the
server (Flask caches templates when the debugger is off).

## Forex with your own Twelve Data key

1. Create a free account at https://twelvedata.com and copy your API key.
2. Copy `live/.env.example` to `live/.env` and put your key in it:

```
TWELVEDATA_API_KEY=your-key-here
```

3. Start (or restart) the server. It reads `live/.env` by itself; the key is never sent to the page.

`live/.env` is git-ignored, so it is never committed. Keep it private (`chmod 600 live/.env`). To
change the key, edit that line and restart the server. A key set with
`export TWELVEDATA_API_KEY=...` in the terminal takes priority over the file.

The free plan limits requests per minute and per day (see your Twelve Data dashboard), so forex
candles refresh every 2 minutes on short intervals, less often on long ones (up to every 15 minutes),
and every 15 minutes while no new candles arrive (for example at the weekend). Each forecast is one
more request, and with **Auto** that means one per closed candle. Leaving several forex charts open
all day can still use up the free daily limit. Crypto refreshes every 5 seconds.

## Using the page

| Area | What it does |
|---|---|
| Market / symbol | Pick Crypto or Forex, then a symbol from the list or type one (`BTCUSDT`, `EUR/USD`) and press Enter (or click elsewhere). |
| Interval | 1m to 1d. |
| Indicators | MA, EMA, BOLL on the price chart; VOL, MACD, RSI in their own panes. Click again to remove. VOL is off for forex (no volume data) and comes back when you return to crypto. |
| Draw | Horizontal line, trend line, ray, Fibonacci. Click the tool, then click on the chart. **Clear** removes all drawings. Drawings stay when you change the interval and are removed when you change the symbol. |
| Kronos | Choose the model, how many candles to forecast and how many samples to average (default 3), then **Forecast**. **Auto** re-runs the forecast each time a candle closes. **Clear** removes the forecast (and cancels one that is still running). |

Forecast candles are drawn in blue/purple with a dashed yellow line through the forecast closes. While
the forecast is on screen, the price axis widens to include it. The page remembers your last market,
symbol and interval; if they can't be loaded, it falls back to BTCUSDT 5m.

How the forecast works and its limits:

- Only finished candles go in; the candle still forming is left out. The first forecast candle is
  therefore the forecast for the forming candle and is drawn on top of it.
- A single sample often moves much further than the real price does; averaging 3–5 samples is steadier.
- Future times are continuous, so a forex forecast made on Friday evening runs through the weekend.
- Forecasts are random samples from a research model. They are not trading advice.

## Files

| File | Purpose |
|---|---|
| `app.py` | Flask server: `/api/candles`, `/api/forecast`, `/api/config` and the page |
| `data_sources.py` | Binance and Twelve Data clients, input validation, short cache |
| `templates/index.html` | Page layout |
| `static/app.js` | Chart, live updates, indicators, drawing tools, forecast overlay |
| `static/style.css` | Dark theme |

## Undo

The `live/` folder is not committed yet. To remove the live chart:

1. Delete the `live/` folder.
2. Remove the `kronos-live` entry from `fx-gtib/.claude/launch.json` (it only starts this server
   from the Claude app).

The `.eval()` fix in `model/kronos.py` is in commit `01580f0` ("checkpoint before live chart"), which
is on both `master` and `live-chart`. To undo it as well: `git revert 01580f0` (this also removes
the restored `examples/data/XSHG_5min_600977.csv`).
