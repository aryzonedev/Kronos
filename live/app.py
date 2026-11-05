"""Kronos live chart: live market candles + Kronos forecasts on a KLineChart page.

Run from the Kronos folder:
    .venv/bin/python live/app.py
then open http://127.0.0.1:7071  (see live/README.md)
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

LIVE_DIR = os.path.dirname(os.path.abspath(__file__))
KRONOS_ROOT = os.path.dirname(LIVE_DIR)
if KRONOS_ROOT not in sys.path:
    sys.path.append(KRONOS_ROOT)


def load_env_file(path: str) -> None:
    """Read KEY=VALUE lines from a private .env file (git-ignored) into the environment.
    A variable that is already set (e.g. with `export`) wins over the file."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(os.path.join(LIVE_DIR, ".env"))

from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402

import data_sources  # noqa: E402
from data_sources import DataSourceError, InputError  # noqa: E402

log = logging.getLogger("kronos-live")

MODELS = {
    "kronos-mini": {
        "name": "Kronos-mini (4.1M)",
        "model_id": "NeoQuasar/Kronos-mini",
        "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-2k",
        "context_length": 2048,
    },
    "kronos-small": {
        "name": "Kronos-small (24.7M)",
        "model_id": "NeoQuasar/Kronos-small",
        "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-base",
        "context_length": 512,
    },
    "kronos-base": {
        "name": "Kronos-base (102.3M)",
        "model_id": "NeoQuasar/Kronos-base",
        "tokenizer_id": "NeoQuasar/Kronos-Tokenizer-base",
        "context_length": 512,
    },
}
DEFAULT_MODEL = "kronos-small"
PRED_LEN_CHOICES = [12, 24, 48, 96, 120]
SAMPLE_COUNT_CHOICES = [1, 2, 3, 5, 10, 15, 25]  # time grows with the count: 25 is 8-10x slower than 3
DEFAULT_SAMPLE_COUNT = 3  # one sample swings much more than the real price; 3 is steadier
MIN_HISTORY = 64          # fewer closed candles than this gives a meaningless forecast
CHART_CANDLES = 500       # candles the page loads on start / symbol change
PRICE_COLS = ["open", "high", "low", "close"]
LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]"}


class ForecastError(Exception):
    """Kronos produced unusable output. The message is safe to show in the page."""


class ForecastService:
    """Loads one Kronos model at a time and runs forecasts one at a time."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model_key: str | None = None
        self._predictor: KronosPredictor | None = None

    def _predictor_for(self, model_key: str) -> KronosPredictor:
        # Caller holds self._lock.
        if self._model_key != model_key:
            cfg = MODELS[model_key]
            log.info("Loading %s ...", cfg["name"])
            tokenizer = KronosTokenizer.from_pretrained(cfg["tokenizer_id"])
            model = Kronos.from_pretrained(cfg["model_id"])
            self._predictor = KronosPredictor(model, tokenizer, max_context=cfg["context_length"])
            self._model_key = model_key
        return self._predictor

    def forecast(self, candles: data_sources.Candles, interval: data_sources.Interval,
                 model_key: str, pred_len: int, sample_count: int) -> dict:
        # Only finished candles go in: the forming one would distort the forecast.
        history = candles.frame[candles.frame["closed"]]
        history = history.tail(MODELS[model_key]["context_length"]).reset_index(drop=True)
        if len(history) < MIN_HISTORY:
            raise InputError(f"Need at least {MIN_HISTORY} closed candles, got {len(history)}")

        last_ts = int(history["timestamp"].iloc[-1])
        future_ts = [last_ts + interval.step_ms * (i + 1) for i in range(pred_len)]
        x_timestamp = pd.Series(pd.to_datetime(history["timestamp"], unit="ms"))
        y_timestamp = pd.Series(pd.to_datetime(future_ts, unit="ms"))
        # Without real volume, let Kronos fill volume/amount with zeros itself.
        columns = PRICE_COLS + (["volume", "amount"] if candles.has_volume else [])

        with self._lock:
            load_started = time.perf_counter()
            predictor = self._predictor_for(model_key)
            model_load_s = time.perf_counter() - load_started
            predict_started = time.perf_counter()
            pred = predictor.predict(
                df=history[columns],
                x_timestamp=x_timestamp,
                y_timestamp=y_timestamp,
                pred_len=pred_len,
                T=1.0,
                top_p=0.9,
                sample_count=sample_count,
                verbose=False,
            )
            took_s = time.perf_counter() - predict_started
            device = str(predictor.device)

        prices = pred[PRICE_COLS].to_numpy(dtype=float)
        if prices.shape != (pred_len, len(PRICE_COLS)) or not np.isfinite(prices).all():
            raise ForecastError("Kronos returned invalid numbers; try again or pick another model")

        forecast = [{"timestamp": ts, "open": o, "high": h, "low": low, "close": c}
                    for ts, (o, h, low, c) in zip(future_ts, prices.tolist())]
        return {
            "model": MODELS[model_key]["name"],
            "device": device,
            "took_s": round(took_s, 2),
            "model_load_s": round(model_load_s, 2),
            "history_candles": len(history),
            "last_close_time": last_ts + interval.step_ms,
            "last_close": float(history["close"].iloc[-1]),
            "forecast_close": forecast[-1]["close"],
            "candles": forecast,
        }


app = Flask(__name__)
forecaster = ForecastService()


@app.before_request
def _only_local_hosts():
    # Blocks DNS-rebinding: a web page on another domain pointed at 127.0.0.1
    # would send its own domain as Host.
    host = request.host.lower()
    hostname = host if host.endswith("]") else host.rsplit(":", 1)[0]
    if hostname not in LOCAL_HOSTNAMES:
        return jsonify(error="Forbidden host"), 403
    return None


@app.errorhandler(InputError)
def _bad_request(exc):
    return jsonify(error=str(exc)), 400


@app.errorhandler(DataSourceError)
def _upstream_error(exc):
    return jsonify(error=str(exc)), 502


@app.errorhandler(ForecastError)
def _forecast_error(exc):
    log.error("Forecast error: %s", exc)
    return jsonify(error=str(exc)), 500


@app.errorhandler(Exception)
def _unexpected_error(exc):
    if isinstance(exc, HTTPException):  # 404, 405, ...: keep Flask's normal response
        return exc
    log.exception("Unexpected error")
    return jsonify(error=f"Internal error ({type(exc).__name__}), see the server log"), 500


def _candles_payload(candles: data_sources.Candles, market: str, symbol: str, interval_key: str) -> dict:
    return {
        "market": market,
        "symbol": symbol,
        "interval": interval_key,
        "price_precision": candles.price_precision,
        "has_volume": candles.has_volume,
        "candles": [{
            "timestamp": int(r.timestamp),
            "open": float(r.open),
            "high": float(r.high),
            "low": float(r.low),
            "close": float(r.close),
            "volume": float(r.volume),
            "closed": bool(r.closed),
        } for r in candles.frame.itertuples(index=False)],
    }


def _choice(value, name: str, allowed: list[int]) -> int:
    # JSON numbers only: no strings, no booleans (True == 1), no fractions.
    if isinstance(value, bool) or not isinstance(value, int) or value not in allowed:
        raise InputError(f"{name} must be one of {allowed}")
    return value


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config")
def config():
    return jsonify(
        markets={k: {"label": m["label"], "symbols": m["symbols"], "has_volume": m["has_volume"]}
                 for k, m in data_sources.MARKETS.items()},
        intervals=[{"key": i.key, "period": {"type": i.period_type, "span": i.period_span},
                    "step_ms": i.step_ms} for i in data_sources.INTERVALS.values()],
        models=[{"key": k, "name": m["name"]} for k, m in MODELS.items()],
        default_model=DEFAULT_MODEL,
        pred_len_choices=PRED_LEN_CHOICES,
        sample_count_choices=SAMPLE_COUNT_CHOICES,
        default_sample_count=DEFAULT_SAMPLE_COUNT,
        chart_candles=CHART_CANDLES,
        forex_key_configured=data_sources.twelvedata_key_configured(),
    )


@app.route("/api/candles")
def candles():
    market = request.args.get("market", "")
    interval_key = request.args.get("interval", "")
    symbol, _ = data_sources.validate_request(market, request.args.get("symbol", ""), interval_key)
    limit_text = request.args.get("limit", str(CHART_CANDLES))
    if not limit_text.isdigit():
        raise InputError("limit must be a whole number")
    result = data_sources.get_candles(market, symbol, interval_key, int(limit_text))
    return jsonify(_candles_payload(result, market, symbol, interval_key))


@app.route("/api/forecast", methods=["POST"])
def forecast():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise InputError("Expected a JSON body")
    market = str(body.get("market", ""))
    symbol, interval = data_sources.validate_request(market, str(body.get("symbol", "")),
                                                     str(body.get("interval", "")))
    model_key = str(body.get("model", DEFAULT_MODEL))
    if model_key not in MODELS:
        raise InputError(f"Unknown model: {model_key!r}")
    pred_len = _choice(body.get("pred_len"), "pred_len", PRED_LEN_CHOICES)
    sample_count = _choice(body.get("sample_count"), "sample_count", SAMPLE_COUNT_CHOICES)

    # One extra candle so the history is still full after the forming candle is dropped.
    limit = min(MODELS[model_key]["context_length"] + 1, data_sources.MARKETS[market]["max_limit"])
    history = data_sources.get_candles(market, symbol, interval.key, limit)
    result = forecaster.forecast(history, interval, model_key, pred_len, sample_count)
    result.update(market=market, symbol=symbol, interval=interval.key)
    return jsonify(result)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    port = int(os.environ.get("KRONOS_LIVE_PORT", "7071"))
    # Bound to this computer only, with the debugger off.
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
