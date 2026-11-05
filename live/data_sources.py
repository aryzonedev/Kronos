"""Live OHLCV candles from public market-data APIs (no CSV files).

Sources:
- crypto: Binance public REST API (no API key needed).
- forex:  Twelve Data REST API. Set the TWELVEDATA_API_KEY environment variable
          to use your own free key; without it the public "demo" key is used,
          which only serves a few symbols such as EUR/USD.
"""
from __future__ import annotations

import math
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime

import pandas as pd
import requests

REQUEST_TIMEOUT_S = 15
BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
TWELVEDATA_SERIES_URL = "https://api.twelvedata.com/time_series"
MAX_PRICE_PRECISION = 8


class InputError(Exception):
    """The request from the page is invalid. The message is safe to show in the page."""


class DataSourceError(Exception):
    """A market-data request failed. The message is safe to show in the page."""


@dataclass(frozen=True)
class Interval:
    key: str            # what the page sends, e.g. "5m"
    binance: str        # Binance interval name
    twelvedata: str     # Twelve Data interval name
    period_type: str    # KLineChart period type
    period_span: int    # KLineChart period span
    step: timedelta     # length of one candle

    @property
    def step_ms(self) -> int:
        return int(self.step.total_seconds() * 1000)


INTERVALS = {i.key: i for i in (
    Interval("1m", "1m", "1min", "minute", 1, timedelta(minutes=1)),
    Interval("5m", "5m", "5min", "minute", 5, timedelta(minutes=5)),
    Interval("15m", "15m", "15min", "minute", 15, timedelta(minutes=15)),
    Interval("30m", "30m", "30min", "minute", 30, timedelta(minutes=30)),
    Interval("1h", "1h", "1h", "hour", 1, timedelta(hours=1)),
    Interval("4h", "4h", "4h", "hour", 4, timedelta(hours=4)),
    Interval("1d", "1d", "1day", "day", 1, timedelta(days=1)),
)}

MARKETS = {
    "crypto": {
        "label": "Crypto (Binance)",
        "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"],
        "pattern": re.compile(r"^[A-Z0-9]{2,20}$"),
        "max_limit": 1000,       # Binance klines maximum per request
        "cache_ttl_s": 2.0,
        "has_volume": True,
    },
    "forex": {
        "label": "Forex (Twelve Data)",
        "symbols": ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "XAU/USD"],
        "pattern": re.compile(r"^[A-Z]{3}/[A-Z]{3}$"),
        "max_limit": 5000,       # Twelve Data outputsize maximum
        "cache_ttl_s": 20.0,     # the free plan has per-minute request limits
        "has_volume": False,     # forex has no central volume
    },
}


@dataclass
class Candles:
    # Columns: timestamp (ms, UTC, candle open time), open, high, low, close,
    # volume, amount, closed (False for the candle that is still forming).
    frame: pd.DataFrame
    price_precision: int
    has_volume: bool


def twelvedata_key_configured() -> bool:
    return bool(os.environ.get("TWELVEDATA_API_KEY", "").strip())


def validate_request(market: str, symbol: str, interval_key: str) -> tuple[str, Interval]:
    """Check the page's input and return the normalized symbol and interval."""
    spec = MARKETS.get(market)
    if spec is None:
        raise InputError(f"Unknown market: {market!r}")
    symbol = (symbol or "").strip().upper()
    if not spec["pattern"].match(symbol):
        raise InputError(f"Invalid {market} symbol {symbol!r} (example: {spec['symbols'][0]})")
    interval = INTERVALS.get(interval_key)
    if interval is None:
        raise InputError(f"Unknown interval: {interval_key!r}")
    return symbol, interval


_cache: dict[tuple, tuple[float, Candles]] = {}
_cache_lock = threading.Lock()


def get_candles(market: str, symbol: str, interval_key: str, limit: int) -> Candles:
    """Return the latest `limit` candles, oldest first. Results are cached briefly."""
    symbol, interval = validate_request(market, symbol, interval_key)
    spec = MARKETS[market]
    if not 1 <= limit <= spec["max_limit"]:
        raise InputError(f"limit must be between 1 and {spec['max_limit']}")

    key = (market, symbol, interval.key, limit)
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None and now - hit[0] < spec["cache_ttl_s"]:
            return hit[1]

    if market == "crypto":
        candles = _fetch_binance(symbol, interval, limit)
    else:
        candles = _fetch_twelvedata(symbol, interval, limit)

    with _cache_lock:
        now = time.monotonic()
        for stale in [k for k, (t, _) in _cache.items() if now - t >= MARKETS[k[0]]["cache_ttl_s"]]:
            del _cache[stale]
        _cache[key] = (now, candles)
    return candles


def _get_json(url: str, params: dict, source: str):
    """GET a JSON document. Returns (HTTP status, payload, server time in ms)."""
    try:
        resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_S)
    except requests.RequestException as exc:
        # Only the exception type: its text can contain the URL, including an API key.
        raise DataSourceError(f"{source}: network error ({type(exc).__name__})") from None
    try:
        payload = resp.json()
    except ValueError:
        raise DataSourceError(f"{source}: unexpected response (HTTP {resp.status_code})") from None
    return resp.status_code, payload, _server_time_ms(resp)


def _server_time_ms(resp: requests.Response) -> int:
    """The data provider's clock (HTTP Date header), so a wrong local clock can't
    mark a forming candle as closed. Falls back to the local clock."""
    try:
        return int(parsedate_to_datetime(resp.headers["Date"]).timestamp() * 1000)
    except (KeyError, TypeError, ValueError, IndexError):
        return int(time.time() * 1000)


def _decimals(text: str) -> int:
    try:
        exponent = Decimal(text).normalize().as_tuple().exponent
    except InvalidOperation:
        return 0
    return max(0, -exponent) if isinstance(exponent, int) else 0


def _price_precision(raw_prices) -> int:
    return min(MAX_PRICE_PRECISION, max((_decimals(str(p)) for p in raw_prices), default=2))


def _finished(rows: list[dict], last_close_ms: int, server_now_ms: int) -> None:
    """Mark rows closed. Only the newest candle can still be forming."""
    for row in rows:
        row["closed"] = True
    rows[-1]["closed"] = last_close_ms <= server_now_ms


def _check_numbers(rows: list[dict], source: str) -> None:
    for row in rows:
        values = (row["open"], row["high"], row["low"], row["close"], row["volume"], row["amount"])
        if not all(math.isfinite(v) for v in values):
            raise DataSourceError(f"{source}: received invalid numbers")


def _fetch_binance(symbol: str, interval: Interval, limit: int) -> Candles:
    status, payload, server_now_ms = _get_json(
        BINANCE_KLINES_URL,
        {"symbol": symbol, "interval": interval.binance, "limit": limit},
        "Binance",
    )
    if status != 200 or not isinstance(payload, list):
        if status == 451:
            message = "not available from your location (HTTP 451)"
        elif isinstance(payload, dict) and payload.get("msg"):
            message = str(payload["msg"])
        else:
            message = f"HTTP {status}"
        raise DataSourceError(f"Binance: {message}")
    if not payload:
        raise DataSourceError(f"Binance: no candles for {symbol}")

    try:
        rows = [{
            "timestamp": int(k[0]),
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
            "amount": float(k[7]),          # quote-asset volume
        } for k in payload]
        rows.sort(key=lambda r: r["timestamp"])
        _finished(rows, int(payload[-1][6]), server_now_ms)   # k[6] is the candle close time
        precision = _price_precision(p for k in payload for p in k[1:5])
    except (TypeError, ValueError, IndexError, KeyError):
        raise DataSourceError("Binance: unexpected data format") from None
    _check_numbers(rows, "Binance")
    return Candles(pd.DataFrame(rows), precision, has_volume=True)


def _fetch_twelvedata(symbol: str, interval: Interval, limit: int) -> Candles:
    api_key = os.environ.get("TWELVEDATA_API_KEY", "").strip() or "demo"
    status, payload, server_now_ms = _get_json(
        TWELVEDATA_SERIES_URL,
        {
            "symbol": symbol,
            "interval": interval.twelvedata,
            "outputsize": limit,
            "timezone": "UTC",
            "apikey": api_key,
        },
        "Twelve Data",
    )
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        message = payload.get("message") if isinstance(payload, dict) else None
        message = str(message or f"HTTP {status}")
        if api_key != "demo":
            message = message.replace(api_key, "***")   # never pass the key on to the page
        raise DataSourceError(f"Twelve Data: {message}")
    values = payload.get("values") or []
    if not values:
        raise DataSourceError(f"Twelve Data: no candles for {symbol}")

    try:
        starts = pd.to_datetime([v["datetime"] for v in values], utc=True)
        rows = [{
            "timestamp": int(start.timestamp() * 1000),
            "open": float(v["open"]),
            "high": float(v["high"]),
            "low": float(v["low"]),
            "close": float(v["close"]),
            "volume": 0.0,
            "amount": 0.0,
        } for v, start in zip(values, starts)]
        rows.sort(key=lambda r: r["timestamp"])
        _finished(rows, rows[-1]["timestamp"] + interval.step_ms, server_now_ms)
        precision = _price_precision(v[f] for v in values for f in ("open", "high", "low", "close"))
    except (TypeError, ValueError, KeyError):
        raise DataSourceError("Twelve Data: unexpected data format") from None
    _check_numbers(rows, "Twelve Data")
    return Candles(pd.DataFrame(rows), precision, has_volume=False)
