from __future__ import annotations

import argparse
import base64
import concurrent.futures
import csv
import gzip
import io
import json
import math
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
START = date(1976, 11, 14)
EPOCH = date(1970, 1, 1)
CHINA_TZ = ZoneInfo("Asia/Shanghai")
US_TZ = ZoneInfo("America/New_York")
UTC = timezone.utc
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/"
EAST = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
EAST_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"
CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD/"
ARCHIVE = "https://www.forecasts.org/data/data/w5000M.htm"
SNAPSHOT = ROOT / "市场数据快照.json"
SERIES = [
    ("W5000", "威尔希尔 5000", "美股全市场", "us", "^W5000", "点"),
    ("SPX", "标普 500", "美股大盘股", "us", "^GSPC", "点"),
    ("COMP", "纳斯达克综合", "纳斯达克上市公司", "us", "^IXIC", "点"),
    ("NDX", "纳斯达克 100", "纳斯达克大型非金融股", "us", "^NDX", "点"),
    ("VTI", "VTI", "美股全市场 ETF", "us", "VTI", "USD"),
    ("SPY", "SPY", "标普 500 ETF", "us", "SPY", "USD"),
    ("VOO", "VOO", "标普 500 ETF", "us", "VOO", "USD"),
    ("IVV", "IVV", "标普 500 ETF", "us", "IVV", "USD"),
    ("QQQ", "QQQ", "纳斯达克 100 ETF", "us", "QQQ", "USD"),
    ("QQQM", "QQQM", "纳斯达克 100 ETF", "us", "QQQM", "USD"),
    ("ONEQ", "ONEQ", "纳斯达克综合 ETF", "us", "ONEQ", "USD"),
    ("SSE", "上证综指", "上海市场长期基准", "cn", "000001", "点"),
    ("CSI300", "沪深 300", "沪深大盘股", "cn", "000300", "点"),
    ("CSIALL", "中证全指", "A 股宽基", "cn", "000985", "点"),
    ("BTC", "比特币", "现货 BTC/USD", "btc", "BTC-USD", "USD"),
]
ETF = {"VTI", "SPY", "VOO", "IVV", "QQQ", "QQQM", "ONEQ"}
HISTORY_LOCK = threading.Lock()
QUOTE_LOCK = threading.Lock()
cache = {"quote": {}, "quote_time": 0, "history_checked": 0}


def now():
    return datetime.now(UTC)


def ordinal(day):
    return (day - EPOCH).days


def day_at(stamp, tz):
    return ordinal(datetime.fromtimestamp(stamp, tz).date())


def params(url, **values):
    return url + "?" + urlencode(values)


def request(url, decode=True):
    req = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json, text/html"})
    with urlopen(req, timeout=12) as response:
        data = response.read()
    return json.loads(data) if decode else data.decode("utf-8", errors="replace")


def yahoo_payload(symbol, **kwargs):
    address = quote(symbol, safe="")
    last_error = None
    for host in (YAHOO, YAHOO.replace("query1", "query2")):
        try:
            result = request(params(host + address, **kwargs))["chart"]["result"][0]
            return result
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            last_error = error
    raise RuntimeError(f"Yahoo {symbol}: {last_error}")


def numeric(value, digits=None):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None
    if not math.isfinite(number) or number <= 0:
        return None
    return round(number, digits) if digits is not None else number


def yahoo_rows(raw, code, before=None):
    meta = raw["meta"]
    tz = ZoneInfo(meta["exchangeTimezoneName"])
    quote_data = raw["indicators"]["quote"][0]["close"]
    digits = 6 if code in ETF else 3
    result = {}
    for stamp, price in zip(raw["timestamp"], quote_data, strict=True):
        value = numeric(price, digits)
        if value is not None and (before is None or stamp < before):
            result[day_at(stamp, tz)] = value
    return result


def yahoo_history(code, symbol, existing):
    # An overlap protects against changes to split-adjusted history after a split.
    etf_start = max(existing) - 45 if existing else ordinal(START)
    recent = code in ETF and bool(existing)
    start = EPOCH + timedelta(days=etf_start) if recent else START
    first = int(datetime.combine(start, datetime.min.time(), UTC).timestamp())
    end_day = now().date() + timedelta(days=2)
    last = int(datetime.combine(end_day, datetime.min.time(), UTC).timestamp())
    raw = yahoo_payload(symbol, period1=first, period2=last, interval="1d")
    if raw["meta"].get("dataGranularity") != "1d":
        raise ValueError(f"{symbol} returned non-daily history")
    period = raw["meta"].get("currentTradingPeriod", {}).get("regular", {})
    before = period.get("start") if period.get("start", 0) <= now().timestamp() < period.get("end", 0) else None
    rows = yahoo_rows(raw, code, before)
    if recent:
        overlap = existing.keys() & rows.keys()
        changed = any(abs(rows[d] / existing[d] - 1) > 0.0005 for d in overlap)
        if changed or not overlap:
            return yahoo_history(code, symbol, {})
        rows = existing | rows
    if code == "W5000":
        if existing:
            older = {day: value for day, value in existing.items() if day < min(rows)}
        else:
            archived = {ordinal(date.fromisoformat(d)): float(v) for d, v in re.findall(
                r"^\s*(\d{4}-\d{2}-\d{2})\s+(\d+\.\d+)\s*$",
                request(ARCHIVE, decode=False),
                re.MULTILINE,
            )}
            overlap = sorted(rows.keys() & archived.keys())[:250]
            if len(overlap) < 225 or max(abs(rows[day] - archived[day]) for day in overlap) >= 0.01:
                raise ValueError("Wilshire archive overlap failed")
            older = {day: value for day, value in archived.items() if ordinal(START) <= day < min(rows)}
        rows = older | rows
    if len(rows) < 1000:
        raise ValueError(f"Unexpectedly short {symbol} history")
    return rows


def china_history(symbol, existing):
    start = EPOCH + timedelta(days=max(existing) - 30) if existing else date(1990, 12, 19)
    raw = request(params(EAST, secid=f"1.{symbol}", klt=101, fqt=0, beg=start.strftime("%Y%m%d"),
                         end="20500101", lmt=20000, fields1="f1,f2,f3,f4,f5,f6",
                         fields2="f51,f52,f53"))["data"]["klines"]
    current = now().astimezone(CHINA_TZ)
    rows = {}
    for line in raw:
        date_string, _, close = line.split(",")
        date_value = date.fromisoformat(date_string)
        result = numeric(close)
        if result is not None and (date_value < current.date() or
                                   (date_value == current.date() and current.hour >= 15)):
            rows[ordinal(date_value)] = result
    if not rows and not existing:
        raise ValueError(f"No China history for {symbol}")
    return existing | rows


def bitcoin_history(existing):
    start = EPOCH + timedelta(days=max(existing) - 30) if existing else date(2010, 7, 18)
    url = params(CM, assets="btc", metrics="PriceUSD", frequency="1d", page_size=10000,
                 start_time=start.isoformat())
    rows = {}
    while url:
        payload = request(url)
        for point in payload["data"]:
            price = numeric(point.get("PriceUSD"))
            if price is not None:
                rows[ordinal(date.fromisoformat(point["time"][:10]))] = price
        url = payload.get("next_page_url")
    if not rows and not existing:
        raise ValueError("Empty Coin Metrics history")
    return existing | rows


def fetch_history(row, snapshot):
    code, _, _, market, symbol, _ = row
    existing = dict(snapshot.get("series", {}).get(code, []))
    if market == "us":
        return yahoo_history(code, symbol, existing)
    if market == "cn":
        return china_history(symbol, existing)
    return bitcoin_history(existing)


def yahoo_quote(code, symbol):
    raw = yahoo_payload(symbol, range="5d", interval="1d")
    meta = raw["meta"]
    timestamp = int(meta["regularMarketTime"])
    tz = ZoneInfo(meta["exchangeTimezoneName"])
    day = day_at(timestamp, tz)
    rows = yahoo_rows(raw, code)
    prior = [point for point in rows if point < day]
    prev = rows[max(prior)] if prior else None
    change = (float(meta["regularMarketPrice"]) / prev - 1) if prev else None
    period = meta.get("currentTradingPeriod", {}).get("regular", {})
    in_session = period.get("start", 0) <= now().timestamp() < period.get("end", 0)
    return quote_record(meta["regularMarketPrice"], timestamp, day, change,
                        "Yahoo Finance", "盘中报价" if in_session and day == day_at(now().timestamp(), tz)
                        else "最近常规时段", "美股较上一收盘")


def china_quote(symbol):
    raw = request(params(EAST_QUOTE, secid=f"1.{symbol}",
                         fields="f43,f57,f58,f59,f60,f86,f124"))["data"]
    timestamp = int(raw["f86"])
    if not 946684800 < timestamp < now().timestamp() + 3600:
        timestamp = int(raw["f124"])
    price = float(raw["f43"]) / 10 ** int(raw["f59"])
    prev = numeric(raw.get("f60"))
    change = float(raw["f43"]) / prev - 1 if prev else None
    local = now().astimezone(CHINA_TZ)
    clock = local.hour * 60 + local.minute
    day = day_at(timestamp, CHINA_TZ)
    in_session = day == ordinal(local.date()) and (570 <= clock < 690 or 780 <= clock < 900)
    return quote_record(price, timestamp, day, change, "东方财富",
                        "盘中报价" if in_session else "最近报价", "A 股较上一收盘")


def bitcoin_quote():
    raw = request(COINBASE + "ticker")
    timestamp = int(datetime.fromisoformat(raw["time"].replace("Z", "+00:00")).timestamp())
    price = float(raw["price"])
    change = None
    try:
        opening = numeric(request(COINBASE + "stats").get("open"))
        if opening:
            change = price / opening - 1
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return quote_record(price, timestamp, day_at(timestamp, UTC), change, "Coinbase Exchange",
                        "最新成交", "BTC 过去 24 小时")


def quote_record(price, timestamp, day, change, source, status, reference):
    value = numeric(price)
    if not value or not 946684800 < timestamp < now().timestamp() + 3600:
        raise ValueError("Invalid quote or timestamp")
    return {"value": value, "time": timestamp, "day": day, "change": change,
            "source": source, "status": status, "reference": reference}


def result_for(row, fn, *args):
    try:
        return row[0], fn(row, *args), None
    except Exception as error:
        return row[0], None, str(error)


def fetch_quote(row):
    code, _, _, market, symbol, _ = row
    if market == "us":
        return yahoo_quote(code, symbol)
    if market == "cn":
        return china_quote(symbol)
    return bitcoin_quote()


def quote_batch(previous=None, force=False):
    with QUOTE_LOCK:
        if not force and time.monotonic() - cache["quote_time"] < 50 and cache["quote"]:
            return cache["quote"]
        previous = previous or cache["quote"].get("items", {})
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
            results = list(executor.map(lambda row: result_for(row, fetch_quote), SERIES))
        items = {}
        errors = {}
        for code, data, error in results:
            if error:
                errors[code] = error
                if code in previous:
                    items[code] = dict(previous[code], stale=True)
            else:
                items[code] = data
        result = {"items": items, "errors": errors, "checked": int(now().timestamp())}
        cache.update(quote=result, quote_time=time.monotonic())
        write_atomic(ROOT / "最近行情快照.json", json.dumps(result, ensure_ascii=False))
        return result


def load_snapshot():
    return json.loads(SNAPSHOT.read_text()) if SNAPSHOT.exists() else {}


def write_atomic(path, text):
    pending = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    pending.write_text(text, encoding="utf-8")
    pending.replace(path)


def series_source(code, market, day):
    if code == "W5000" and day < ordinal(date(1989, 1, 3)):
        return "Wilshire WILL5000PR 档案"
    if market == "cn":
        return "东方财富"
    if market == "btc":
        return "Coin Metrics PriceUSD"
    return "Yahoo Finance"


def write_csv(snapshot):
    fp = io.StringIO(newline="")
    writer = csv.writer(fp)
    writer.writerow(["代码", "名称", "市场", "日期", "原始数值", "单位", "序列首日",
                     "序列起点数值", "累计涨幅(%)", "数值倍数", "口径", "来源"])
    summary = io.StringIO(newline="")
    total = csv.writer(summary)
    total.writerow(["代码", "名称", "首个记录日", "基准值", "最近记录日", "最近数值",
                    "单位", "累计涨幅(%)", "数值倍数", "记录数", "口径"])
    for code, name, _, market, _, unit in SERIES:
        points = snapshot["series"][code]
        base_day, base = points[0]
        end_day, end = points[-1]
        basis = "拆分调整收盘价，不含现金分红" if code in ETF else "价格指数，不含股息"
        if code == "BTC":
            basis = "BTC/USD 每日参考价，时间戳为 UTC 00:00"
        bdate = EPOCH + timedelta(days=base_day)
        for day, value in points:
            multiple = value / base
            writer.writerow([code, name, market, EPOCH + timedelta(days=day), value, unit,
                             bdate, base, f"{(multiple - 1) * 100:.8f}", f"{multiple:.10f}",
                             basis, series_source(code, market, day)])
        total.writerow([code, name, bdate, base, EPOCH + timedelta(days=end_day), end, unit,
                        f"{(end / base - 1) * 100:.8f}", f"{end / base:.10f}", len(points), basis])
    early = snapshot["early"]
    writer.writerow(["BTC_EARLY", "比特币早期报价", "btc", EPOCH + timedelta(days=early[0]),
                     early[1], "USD", "", "", "", "", "估算汇率，美国电费成本法，独立参考点",
                     "New Liberty Standard；Luther (2019)"])
    write_atomic(ROOT / "历史日线数据.csv", "\ufeff" + fp.getvalue())
    write_atomic(ROOT / "曲线起点与累计涨幅.csv", "\ufeff" + summary.getvalue())


def refresh_history(force=False):
    with HISTORY_LOCK:
        snapshot = load_snapshot()
        if not force and snapshot and now().timestamp() - snapshot["checked"] < 3600:
            return snapshot
        if not force and time.monotonic() - cache["history_checked"] < 240:
            return snapshot
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
            results = list(executor.map(lambda row: result_for(row, fetch_history, snapshot), SERIES))
        data = snapshot.get("series", {}).copy()
        issues = {}
        for code, rows, error in results:
            if error:
                issues[code] = error
            elif rows:
                packed = [list(item) for item in sorted(rows.items())]
                if code in data and packed[-1][0] < data[code][-1][0]:
                    issues[code] = "History provider returned an older endpoint"
                else:
                    data[code] = packed
        missing = [row[0] for row in SERIES if row[0] not in data]
        if missing:
            raise RuntimeError(f"Missing histories {missing}: {issues}")
        snapshot = {"series": data, "metadata": SERIES, "early": [ordinal(date(2009, 10, 5)), 1 / 1309.03],
                    "checked": int(now().timestamp()), "issues": issues}
        write_atomic(SNAPSHOT, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
        write_csv(snapshot)
        cache["history_checked"] = time.monotonic()
        return snapshot


def make_html(snapshot, quotes, inline=False):
    payload = dict(snapshot, initialQuotes=quotes)
    compressed = base64.b64encode(gzip.compress(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    )).decode()
    html = (ROOT / "market-chart.html").read_text()
    css = (ROOT / "market-chart.css").read_text()
    script = (ROOT / "market-chart.js").read_text()
    html = html.replace("<!--CHART_DATA-->", compressed).replace("<!--CHART_SCRIPT-->", script)
    html = html.replace("<!--CHART_STYLE-->", css).replace("<!--CHART_MODE-->", "inline" if inline else "local")
    if inline:
        return html
    return ('<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>全球市场涨幅对比</title><link rel="icon" href="data:,"></head><body>' + html +
            '</body></html>')


class MarketHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if args and str(args[1]) not in {"200", "304"}:
            super().log_message(format, *args)

    def deliver(self, text, content_type, attachment=None, status=200):
        content = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if attachment:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(attachment)}")
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}",
                                          f"localhost:{self.server.server_port}"}:
            self.deliver("Invalid host", "text/plain", status=400)
            return
        path = urlsplit(self.path).path
        try:
            if path in ("/", "/index.html"):
                snapshot = load_snapshot()
                quotes = cache["quote"] or load_seed_quotes()
                self.deliver(make_html(snapshot, quotes), "text/html; charset=utf-8")
            elif path == "/quotes":
                result = quote_batch(load_seed_quotes().get("items", {}))
                self.deliver(json.dumps(result, ensure_ascii=False), "application/json; charset=utf-8")
            elif path == "/history":
                result = refresh_history()
                self.deliver(json.dumps(result, ensure_ascii=False), "application/json; charset=utf-8")
            elif path in {"/data.csv", "/summary.csv"}:
                filename = "历史日线数据.csv" if path == "/data.csv" else "曲线起点与累计涨幅.csv"
                self.deliver((ROOT / filename).read_text(), "text/csv; charset=utf-8", attachment=filename)
            elif path == "/health":
                self.deliver("global-market-chart", "text/plain; charset=utf-8")
            else:
                self.deliver("Not found", "text/plain", status=404)
        except Exception as error:
            self.deliver(str(error), "text/plain; charset=utf-8", status=502)


def load_seed_quotes():
    path = ROOT / "最近行情快照.json"
    return json.loads(path.read_text()) if path.exists() else {"items": {}}


def main():
    cli = argparse.ArgumentParser(description="本机全球市场涨幅对比")
    cli.add_argument("--serve", action="store_true")
    cli.add_argument("--port", type=int, default=8769)
    cli.add_argument("--build", action="store_true")
    cli.add_argument("--inline", type=Path)
    args = cli.parse_args()
    if args.build:
        snapshot = refresh_history(force=True)
        quotes = quote_batch(load_seed_quotes().get("items", {}), force=True)
    else:
        snapshot = load_snapshot()
        quotes = load_seed_quotes()
    if args.inline:
        write_atomic(args.inline, make_html(snapshot, quotes, inline=True))
    if args.serve:
        if not snapshot:
            refresh_history(force=True)
        server = ThreadingHTTPServer(("127.0.0.1", args.port), MarketHandler)
        print(f"http://127.0.0.1:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
