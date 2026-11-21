(async () => {
  "use strict";
  const root = document.getElementById("global-market-returns");
  const get = selector => root.querySelector(selector);
  const local = root.dataset.mode === "local";
  const dayMs = 86400000;
  const iso = day => new Date(day * dayMs).toISOString().slice(0, 10);
  const asDay = date => Math.round(Date.parse(date) / dayMs);
  const yearOf = day => Number(iso(day).slice(0, 4));
  const jan = year => asDay(String(year) + "-01-01");
  const percent = (v, digits = 2) => (v > 0 ? "+" : "") +
    new Intl.NumberFormat("zh-CN", {maximumFractionDigits: digits}).format(v * 100) + "%";
  const number = (v, digits = 2) => new Intl.NumberFormat("zh-CN", {maximumFractionDigits: digits}).format(v);
  const precision = v => v < 0.01 ? 8 : v < 1 ? 5 : 2;
  const rawValue = (v, unit) => number(v, precision(v)) + (unit === "点" ? " 点" : " USD");
  const marketTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const colors = [1, 2, 3, 4, 1, 2, 2, 2, 4, 4, 3, 6, 3, 6, 5];
  const patterns = [[], [], [], [], [7,3], [7,3], [2,3], [9,3,2,3], [7,3], [2,3], [7,3], [6,3], [2,3], [], []];
  const usDefault = ["W5000","SPX","COMP","NDX","QQQ","SPY","VTI"];
  const compareDefault = ["W5000","SPX","QQQ","SSE","CSI300","CSIALL","BTC"];
  const tooltipLead = (value, base, unit, kind) => {
    if (kind === "drawdown") return "距离历史高点 " + percent(value);
    if (kind === "price") return rawValue(value, unit);
    return rawValue(value, unit) + "  ·  " + percent(value / base - 1);
  };

  function lower(points, day) {
    let a = 0;
    let b = points.length;
    while (a < b) {
      const m = Math.floor((a + b) / 2);
      if (points[m][0] < day) a = m + 1;
      else b = m;
    }
    return a;
  }

  function onOrBefore(points, day) {
    const i = lower(points, day);
    if (points[i]?.[0] === day) return points[i];
    return points[i - 1];
  }

  function sharedDate(codes, target, data) {
    const ordered = codes.map(code => data[code]).sort((a,b) => a.length - b.length);
    if (!ordered.length) return null;
    const first = ordered.shift();
    for (let i = lower(first, target); i < first.length; i++) {
      const day = first[i][0];
      if (ordered.every(points => points[lower(points, day)]?.[0] === day)) return day;
    }
    return null;
  }

  try {
    const bytes = Uint8Array.from(atob(get("[data-market-payload]").textContent.trim()), item => item.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    let payload = JSON.parse(await new Response(stream).text());
    const meta = Object.fromEntries(payload.metadata.map(([code, name, detail, market, symbol, unit], index) =>
      [code, {code, name, detail, market, symbol, unit, color: colors[index], dash: patterns[index]}]));
    const names = Object.keys(meta);
    const usCodes = names.filter(code => meta[code].market === "us");
    const selection = {us: new Set(usDefault), compare: new Set(compareDefault)};
    let quotes = payload.initialQuotes;
    function endDay() {
      return Math.max(...Object.values(payload.series).map(points => points.at(-1)[0]));
    }
    function yearsAgo(years) {
      const end = new Date(endDay() * dayMs);
      const month = end.getUTCMonth();
      end.setUTCFullYear(end.getUTCFullYear() - years);
      if (end.getUTCMonth() !== month) end.setUTCDate(0);
      return Math.round(end.getTime() / dayMs);
    }

    const fields = {
      usScale: get("[data-us-scale]"), btcMetric: get("[data-btc-metric]"),
      btcRange: get("[data-btc-range]"), compareScale: get("[data-compare-scale]"),
      start: get("[data-start]")
    };
    fields.start.value = iso(yearsAgo(5));
    fields.start.min = "1976-11-14";
    fields.start.max = iso(endDay());
    for (const element of root.querySelectorAll(".market-live")) element.hidden = !local;
    const plots = Object.fromEntries(["us","btc","compare"].map(key => [key, {
      key, box: get("[data-plot-" + key + "]"), field: get("[data-" + key + "-inspect]"),
      readout: get("[data-" + key + "-readout]")
    }]));
    for (const plot of Object.values(plots)) {
      plot.canvas = plot.box.querySelector("canvas");
      plot.tip = plot.box.querySelector(".market-tip");
    }

    function styleColors() {
      const style = getComputedStyle(root);
      const read = property => style.getPropertyValue(property).trim();
      const make = document.createElement("span");
      make.style.display = "none";
      root.append(make);
      const color = property => {
        make.style.color = "var(--" + property + ", " + (read("--foreground") || "currentColor") + ")";
        return getComputedStyle(make).color;
      };
      const palette = [0,1,2,3,4,5,6].map(index => color("viz-series-" + index));
      const result = {ink: color("foreground"), muted: color("muted-foreground"),
        rule: color("border"), paper: color("background"), palette};
      make.remove();
      return result;
    }

    function marketLine(code, points, base, transform, extras = {}) {
      return {code, points, base, transform, ...extras};
    }

    function newestQuote(code, points, from) {
      const quote = local ? quotes?.items?.[code] : null;
      return quote && !quote.stale && quote.day >= points.at(-1)[0] && quote.day >= from ? quote : null;
    }

    function compareSpec() {
      const codes = names.filter(code => selection.compare.has(code));
      const requested = Number.isFinite(asDay(fields.start.value)) ? asDay(fields.start.value) : yearsAgo(5);
      const common = sharedDate(codes, requested, payload.series);
      const end = endDay();
      const axis = fields.compareScale.value;
      const scale = axis === "log" ? (v, b) => v / b : (v, b) => v / b - 1;
      const base = get("[data-baseline]");
      if (common === null) {
        base.textContent = "所选日期以后没有共同观测日。请选更早日期或减少曲线。";
        return {lines: [], from: Math.min(requested, end - 1), to: end, axis, mode: "returns"};
      }
      base.textContent = "实际共同起点 " + iso(common) + "  ·  起点 " +
        (axis === "log" ? "1 倍" : "0%") + (local ? "  ·  空心点为来源最新报价" : "");
      const lines = codes.map(code => {
        const all = payload.series[code];
        const index = lower(all, common);
        const live = newestQuote(code, all, common);
        return marketLine(code, all.slice(index), all[index][1], scale, {live});
      });
      return {lines, from: common, to: Math.max(common, end, ...lines.map(line => line.live?.day || 0)),
        axis, mode: "returns", marker: axis === "log" ? 1 : 0};
    }

    function displaySpec(key) {
      if (key === "compare") return compareSpec();
      if (key === "us") {
        const axis = fields.usScale.value;
        const scale = axis === "log" ? (v, b) => v / b : (v, b) => v / b - 1;
        const lines = usCodes.filter(code => selection.us.has(code)).map(code => {
          const points = payload.series[code];
          return marketLine(code, points, points[0][1], scale);
        });
        return {from: asDay("1976-11-14"), to: endDay(), lines, axis, mode: "returns",
          marker: axis === "log" ? 1 : 0};
      }
      const all = payload.series.BTC;
      const mode = fields.btcMetric.value;
      const range = fields.btcRange.value;
      const from = asDay(range === "all" || range === "early" ? "2009-10-05" : range + "-01-01");
      const throughLatest = range === "all" || range === "2021";
      const live = throughLatest && mode !== "drawdown" ? newestQuote("BTC", all, from) : null;
      const to = throughLatest ? Math.max(all.at(-1)[0], live?.day || 0) :
        asDay(({early: "2013", 2013: "2017", 2017: "2021"})[range] + "-01-01");
      let points = all;
      if (mode === "drawdown") {
        let peak = 0;
        points = all.map(([day, price]) => {
          peak = Math.max(peak, price);
          return [day, price / peak - 1, price, peak];
        });
      }
      const scale = mode === "return" ? (v,b) => v / b : v => v;
      const lines = [marketLine("BTC", points.slice(lower(points,from),lower(points,to+1)), all[0][1], scale, {live})];
      if (mode === "price" && from <= payload.early[0]) {
        lines.unshift(marketLine("BTC", [payload.early], 1, value => value, {early: true}));
      }
      return {lines, from, to, axis: mode === "drawdown" ? "linear" : "log",
        mode: mode === "return" ? "returns" : mode, marker: mode === "drawdown" ? 0 : undefined};
    }

    function valueTicks(values, axis, marker, height) {
      if (Number.isFinite(marker)) values.push(marker);
      if (!values.length) return {ticks: [], low: 0, high: 1};
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (axis === "log") {
        const start = Math.floor(Math.log10(min));
        const finish = Math.ceil(Math.log10(max));
        if (Math.log10(max / min) >= 1.75) {
          const ticks = [];
          for (let e = start; e <= finish; e++) ticks.push(10 ** e);
          const low = Math.max(start, Math.log10(min) - .18);
          const high = Math.min(finish, Math.log10(max) + .18);
          return {ticks, low, high};
        }
        const ticks = [];
        const choices = [1,1.25,1.5,2,2.5,3,4,5,6,8];
        for (let e = start - 1; e <= finish; e++) {
          for (const pick of choices) ticks.push(pick * 10 ** e);
        }
        const sorted = ticks.filter(v => v >= min && v <= max);
        const below = ticks.filter(v => v <= min * .98).at(-1) ?? min;
        const above = ticks.find(v => v > max * 1.02) ?? max;
        const visible = [...new Set([below, ...sorted, above])];
        return {ticks: visible.filter((_, i) => i % Math.max(1, Math.ceil(visible.length / 7)) === 0 || i === visible.length - 1),
          low: Math.log10(below), high: Math.log10(above)};
      }
      const span = max - min || 0.05;
      const rough = span / Math.max(3, Math.floor(height / 55));
      const power = 10 ** Math.floor(Math.log10(rough));
      const step = [1,2,2.5,5,10].map(x => x * power).find(x => x >= rough) || rough;
      const bottom = Math.floor(min / step + 1e-9);
      const top = Math.max(bottom + 1, Math.ceil(max / step - 1e-9));
      const low = Math.max(-1, bottom * step);
      const ticks = Array.from({length: top - bottom + 1}, (_,i) => (i + bottom) * step);
      return {ticks: ticks.filter(tick => tick >= low), low, high: top * step};
    }

    function axisValue(value, spec) {
      if (spec.axis === "linear") {
        return number(value * 100, 2) + "%";
      }
      const formatted = value >= 100000000 ? number(value / 100000000) + "亿" :
        value >= 10000 ? number(value / 10000) + "万" : number(value, 5);
      return spec.mode === "price" ? "$" + formatted : formatted + "×";
    }

    function timeTicks(from, to, width) {
      const count = Math.max(2, Math.floor(width / 105));
      const years = (to - from) / 365.2425;
      if (years >= 2.75) {
        const step = [1,2,3,5,10,15,20,25,50].find(v => v >= years / count) || 50;
        const first = Math.ceil(yearOf(from) / step) * step;
        const result = [];
        for (let year = first; jan(year) <= to; year += step) {
          if (jan(year) >= from) result.push([jan(year), String(year)]);
        }
        return result;
      }
      const step = years >= 1 ? 3 : years > 0.35 ? 2 : 1;
      if (to - from <= 60) {
        const stride = Math.max(1, Math.ceil((to - from) / count));
        return Array.from({length: Math.floor((to - from) / stride)+1}, (_, i) =>
          [from + i*stride, iso(from + i*stride).slice(5)]);
      }
      const first = new Date(from * dayMs);
      first.setUTCDate(1);
      if (from > first.getTime() / dayMs) first.setUTCMonth(first.getUTCMonth()+1);
      const result = [];
      for (;first.getTime() / dayMs <= to; first.setUTCMonth(first.getUTCMonth()+step)) {
        const day = first.getTime() / dayMs;
        result.push([day, iso(day).slice(0,7)]);
      }
      return result;
    }

    function axisText(spec) {
      if (spec.mode === "drawdown") return "距历史高点跌幅 (%)";
      if (spec.mode === "price") return "美元价格（对数）";
      return spec.axis === "log" ? "价格倍数（对数）" : "累计涨幅 (%)";
    }

    function draw(plot, fresh = true) {
      if (fresh) {
        plot.spec = displaySpec(plot.key);
        const {from,to} = plot.spec;
        plot.field.min = iso(from);
        plot.field.max = iso(to);
        if (!plot.selected || plot.selected < from || plot.selected > to) {
          const datedLines = plot.spec.lines.filter(line => !line.early);
        plot.selected = Math.max(from, Math.min(to, ...datedLines.map(line => line.points.at(-1)?.[0] ?? to)));
        }
        plot.field.value = iso(plot.selected);
        plot.tip.hidden = true;
        renderReadout(plot);
      }
      const {canvas, spec} = plot;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      if (!width || !height) return;
      const ctx = canvas.getContext("2d");
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.scale(ratio, ratio);
      const theme = styleColors();
      const baseFont = getComputedStyle(root).fontFamily;
      ctx.font = "12px " + baseFont;
      ctx.lineJoin = "round";
      const values = [];
      for (const line of spec.lines) {
        for (const [,v] of line.points) {
          const n = line.transform(v,line.base);
          if (Number.isFinite(n)) values.push(n);
        }
        if (line.live) values.push(line.transform(line.live.value,line.base));
      }
      const top = 27;
      const bottom = height - 30;
      const ys = valueTicks(values,spec.axis,spec.marker,bottom-top);
      const maxLabel = Math.max(40,...ys.ticks.map(v => ctx.measureText(axisValue(v,spec)).width));
      const left = maxLabel + 12;
      const right = width - 13;
      const xAt = day => spec.to === spec.from ? (left + right) / 2 :
        left + (day-spec.from) / (spec.to-spec.from) * (right-left);
      const yAt = value => bottom - ((spec.axis === "log" ? Math.log10(value) : value)-ys.low) /
        (ys.high-ys.low || 1) * (bottom-top);
      plot.geometry = {left,right,top,bottom,xAt,yAt,theme};
      function segment(x1,y1,x2,y2,color) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.moveTo(Math.round(x1)+.5, Math.round(y1)+.5);
        ctx.lineTo(Math.round(x2)+.5, Math.round(y2)+.5);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(axisText(spec), left, 10);
      ctx.textAlign = "right";
      for (const v of ys.ticks) {
        const y = yAt(v);
        if (y < top - .5 || y > bottom + .5) continue;
        segment(left,y,right,y,theme.rule);
        ctx.fillText(axisValue(v,spec), left-7,y);
      }
      if (Number.isFinite(spec.marker) && yAt(spec.marker) >= top && yAt(spec.marker) <= bottom) {
        ctx.setLineDash([4,4]);
        segment(left, yAt(spec.marker), right, yAt(spec.marker), theme.muted);
        ctx.setLineDash([]);
      }
      ctx.textAlign = "center";
      for (const [day,label] of timeTicks(spec.from,spec.to,width)) {
        const x = xAt(day);
        segment(x,top,x,bottom,theme.rule);
        const half = ctx.measureText(label).width / 2;
        const lx = Math.max(half+2, Math.min(width-half-2,x));
        ctx.fillText(label,lx,bottom+14);
      }
      if (!values.length) {
        ctx.fillStyle = theme.ink;
        ctx.fillText("当前没有可绘制的观察值", (left+right)/2,(top+bottom)/2);
        return;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left-4,top-5,right-left+10,bottom-top+10);
      ctx.clip();
      for (const line of spec.lines) {
        const item = meta[line.code];
        const color = theme.palette[item.color];
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = line.code === "BTC" || line.code === "W5000" ? 2 : 1.45;
        ctx.setLineDash(item.dash);
        ctx.beginPath();
        line.points.forEach(([day,v], i) => {
          const x = xAt(day);
          const y = yAt(line.transform(v,line.base));
          if (i) ctx.lineTo(x,y);
          else ctx.moveTo(x,y);
        });
        if (line.points.length > 1) ctx.stroke();
        ctx.setLineDash([]);
        if (line.points.length === 1) {
          const [day,v] = line.points[0];
          const x = xAt(day);
          const y = yAt(line.transform(v,line.base));
          ctx.beginPath();
          ctx.arc(x,y,line.early ? 5 : 3,0,Math.PI*2);
          if (line.early) ctx.stroke();
          else ctx.fill();
        }
        if (line.live) {
          const x = xAt(line.live.day);
          const y = yAt(line.transform(line.live.value,line.base));
          ctx.beginPath();
          ctx.arc(x,y,3.7,0,Math.PI*2);
          ctx.fillStyle = theme.paper;
          ctx.fill();
          ctx.stroke();
        }
      }
      if (plot.selected >= spec.from && plot.selected <= spec.to) {
        const x = xAt(plot.selected);
        ctx.setLineDash([3,4]);
        ctx.lineWidth = 1;
        segment(x,top,x,bottom,theme.muted);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    function readValues(plot, day) {
      return plot.spec.lines.flatMap(line => {
        const point = onOrBefore(line.points,day);
        if (!point || (line.early && point[0] !== day)) return [];
        const [actual, val, price, peak] = point;
        let label = line.early ? "2009 估算报价" : meta[line.code].name;
        let value = tooltipLead(val,line.base,meta[line.code].unit,plot.spec.mode);
        if (plot.key === "btc" && !line.early && plot.spec.mode === "price") {
          value += "  ·  日线以来 " + percent(val / line.base - 1);
        }
        if (plot.spec.mode === "drawdown") {
          value += "  ·  " + rawValue(price,"USD") + " / 高点 " + rawValue(peak,"USD");
        }
        return [{label,value,actual}];
      });
    }

    function renderReadout(plot) {
      const values = readValues(plot,plot.selected);
      plot.readout.textContent = values.length ? values.map(entry =>
        entry.label + " " + entry.value + (entry.actual !== plot.selected ? "（" + iso(entry.actual) + "）" : "")
      ).join(" ｜ ") : "这一天没有可用观测值";
    }

    function hover(plot, event) {
      if (!plot.geometry) return;
      const bounds = plot.box.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const {left,right,top,bottom} = plot.geometry;
      if (x < left-5 || x > right+5 || y < top || y > bottom+3) {
        plot.tip.hidden = true;
        return;
      }
      const {from,to} = plot.spec;
      const day = Math.max(from,Math.min(to,Math.round(from + (x-left) / (right-left) * (to-from))));
      const values = readValues(plot,day);
      for (const line of plot.spec.lines) {
        if (line.live && Math.abs(plot.geometry.xAt(line.live.day) - x) < 9) {
          values.push({label: meta[line.code].name + " 最新报价",
            value: tooltipLead(line.live.value,line.base,meta[line.code].unit,plot.spec.mode) +
              "（" + marketTime.format(line.live.time * 1000) + "）", actual: day});
        }
      }
      plot.tip.replaceChildren();
      const time = document.createElement("strong");
      time.textContent = iso(day);
      plot.tip.append(time);
      for (const {label,value,actual} of values) {
        const row = document.createElement("div");
        row.textContent = label + "  " + value + (actual === day ? "" : "  ·  " + iso(actual));
        plot.tip.append(row);
      }
      if (values.length === 0) {
        plot.tip.hidden = true;
        return;
      }
      plot.tip.hidden = false;
      const tw = plot.tip.offsetWidth;
      const th = plot.tip.offsetHeight;
      const tx = x < bounds.width - tw - 18 ? x + 12 : Math.max(0, x - tw - 12);
      plot.tip.style.left = tx + "px";
      plot.tip.style.top = Math.max(0,Math.min(y-20,bounds.height-th)) + "px";
      if (event.type === "pointerdown") {
        plot.selected = day;
        plot.field.value = iso(day);
        renderReadout(plot);
        draw(plot,false);
      }
    }

    function refreshLegend(which) {
      const box = get("[data-legend-" + which + "]");
      for (const button of box.querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(selection[which].has(button.dataset.code)));
      }
      const all = get("[data-us-all]");
      all.textContent = selection.us.size === usCodes.length ? "恢复默认美股曲线" : "显示全部美股曲线";
    }

    function setupLegend(which,codes) {
      const box = get("[data-legend-" + which + "]");
      for (const code of codes) {
        const item = meta[code];
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-ghost";
        button.dataset.code = code;
        button.setAttribute("data-tooltip",item.detail + " · " + item.symbol);
        const swatch = document.createElement("span");
        swatch.className = "series-dash";
        swatch.style.setProperty("--series", "var(--viz-series-" + item.color + ")");
        if (item.dash.length) swatch.style.borderTopStyle = "dashed";
        swatch.setAttribute("aria-hidden","true");
        button.append(swatch, item.name);
        button.addEventListener("click", () => {
          const set = selection[which];
          if (set.has(code) && set.size === 1) return;
          if (set.has(code)) set.delete(code);
          else set.add(code);
          refreshLegend(which);
          draw(plots[which]);
        });
        box.append(button);
      }
      refreshLegend(which);
    }

    function showQuotes() {
      const rows = get("[data-quote-rows]");
      rows.replaceChildren();
      const summary = get("[data-quote-summary]");
      const checked = quotes?.checked ? marketTime.format(quotes.checked*1000) : "—";
      summary.textContent = (local ? "轮询时间 " : "行情快照 ") + checked +
        " · 股市为较上一收盘，BTC 为过去 24 小时。";
      for (const code of names) {
        const {name,unit} = meta[code];
        const price = quotes?.items?.[code];
        const line = rows.insertRow();
        const title = document.createElement("th");
        title.scope = "row";
        title.textContent = name;
        line.append(title);
        for (const entry of [price ? rawValue(price.value,unit) : "—",
          price?.change == null ? "—" : percent(price.change),
          price ? marketTime.format(price.time*1000) : "—"]) {
          const cell = line.insertCell();
          cell.className = "text-end";
          cell.textContent = entry;
        }
        if (price?.change != null) line.cells[2].dataset.change = price.change >= 0 ? "up" : "down";
        const label = document.createElement("small");
        label.textContent = price
          ? price.source + " · " + (price.stale ? "刷新失败，保留上次" : price.status)
          : "公开接口暂未返回报价";
        line.cells[3].append(label);
      }
    }

    function displayDates() {
      const start = Math.min(...usCodes.map(code => payload.series[code][0][0]));
      get("[data-overview]").textContent = "美股 " + iso(start) + " — " + iso(endDay()) + "  ·  " +
        names.length + " 条指数、ETF 与比特币曲线";
      fields.start.max = iso(endDay());
    }

    let refreshing = false;
    let lastHistory = 0;
    async function updateLive() {
      if (!local || refreshing) return;
      refreshing = true;
      const button = get("[data-refresh]");
      const status = get("[data-refresh-status]");
      button.disabled = true;
      status.textContent = "正在查询公开行情…";
      try {
        const result = await fetch("/quotes").then(response => {
          if (!response.ok) throw new Error("行情暂不可用");
          return response.json();
        });
        quotes = result;
        showQuotes();
        draw(plots.compare);
        draw(plots.btc);
        const misses = Object.keys(quotes.errors).length;
        status.textContent = misses ? "部分行情未刷新（" + misses + " 条）" : "行情已查询";
      } catch {
        status.textContent = "行情查询失败，仍显示最近一次的数据";
      } finally {
        refreshing = false;
        button.disabled = false;
      }
      if (Date.now() - lastHistory > 3600000) {
        lastHistory = Date.now();
        try {
          const response = await fetch("/history");
          if (!response.ok) throw new Error("History unavailable");
          const newer = await response.json();
          if (newer.checked !== payload.checked) {
            payload = newer;
            displayDates();
            for (const plot of Object.values(plots)) draw(plot);
          }
          if (Object.keys(newer.issues).length) status.textContent += " · 部分日线沿用快照";
        } catch {
          status.textContent += " · 日线刷新暂不可用";
        }
      }
    }

    setupLegend("us",usCodes);
    setupLegend("compare",names);
    displayDates();
    showQuotes();
    for (const plot of Object.values(plots)) {
      plot.canvas.addEventListener("pointermove", event => hover(plot,event));
      plot.canvas.addEventListener("pointerdown", event => hover(plot,event));
      plot.canvas.addEventListener("pointerleave", () => {plot.tip.hidden = true;});
      plot.field.addEventListener("change", () => {
        const day = asDay(plot.field.value);
        if (!Number.isFinite(day)) return;
        plot.selected = Math.max(plot.spec.from,Math.min(day,plot.spec.to));
        plot.field.value = iso(plot.selected);
        draw(plot,false);
        renderReadout(plot);
      });
      new ResizeObserver(() => draw(plot,false)).observe(plot.box);
      draw(plot);
    }
    fields.usScale.addEventListener("change",() => draw(plots.us));
    fields.btcMetric.addEventListener("change",() => {
      if (fields.btcMetric.value !== "price" && plots.btc.selected < payload.series.BTC[0][0]) {
        plots.btc.selected = null;
      }
      draw(plots.btc);
    });
    fields.btcRange.addEventListener("change",() => draw(plots.btc));
    fields.compareScale.addEventListener("change",() => draw(plots.compare));
    fields.start.addEventListener("change",() => {plots.compare.selected = null; draw(plots.compare);});
    get("[data-us-all]").addEventListener("click", () => {
      selection.us = new Set(selection.us.size === usCodes.length ? usDefault : usCodes);
      refreshLegend("us");
      draw(plots.us);
    });
    for (const button of root.querySelectorAll("[data-since]")) {
      button.addEventListener("click",() => {
        const since = button.dataset.since;
        fields.start.value = since === "ytd" ? iso(jan(yearOf(endDay()))) :
          since.length > 2 ? since : iso(yearsAgo(Number(since)));
        plots.compare.selected = null;
        draw(plots.compare);
      });
    }
    const redraw = () => { for (const plot of Object.values(plots)) draw(plot,false); };
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change",redraw);
    new MutationObserver(redraw).observe(document.documentElement,{attributes:true,attributeFilter:["class","style","data-theme"]});
    if (local) {
      get("[data-refresh]").addEventListener("click", updateLive);
      updateLive();
      const timer = setInterval(() => {
        if (!root.isConnected) clearInterval(timer);
        else if (!document.hidden && get("[data-auto]").checked) updateLive();
      },60000);
    }
  } catch (error) {
    get("[data-overview]").textContent = "图表加载失败。请用最新版 Safari 或 Chrome 打开。";
    console.error(error);
  }
})();
