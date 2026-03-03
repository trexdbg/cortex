const REFRESH_MS = 30000;
      const TRADE_HISTORY_LIMIT = 140;
      const TRADE_WINDOW_BEFORE_POINTS = 160;
      const TRADE_WINDOW_AFTER_POINTS = 60;
      const TRADE_CONTEXT_BARS = 12;
      const ALLOCATION_COLORS = ["#0e7c66", "#2a9d8f", "#26547c", "#6a4c93", "#d97706", "#5b8f29", "#b3263a", "#577590", "#7a7f9a"];

      let stateCache = null;
      let selectedAnalystId = null;
      let selectedTradeKey = null;
      let equityChart = null;
      let tradeChart = null;

      const esc = (v) => String(v ?? "-").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
      const fmtN = (v, d = 2) => num(v) === null ? "-" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
      const fmtM = (v, d = 2) => num(v) === null ? "-" : "$" + fmtN(v, d);
      const fmtSM = (v, d = 2) => num(v) === null ? "-" : `${Number(v) > 0 ? "+" : ""}$${fmtN(v, d)}`;
      const fmtP = (v, d = 2) => num(v) === null ? "-" : `${Number(v).toFixed(d)}%`;
      const fmtSP = (v, d = 2) => num(v) === null ? "-" : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(d)}%`;
      const cssSign = (v) => num(v) === null || Number(v) === 0 ? "" : Number(v) > 0 ? "pos" : "neg";
      const toUnix = (ts) => { const t = new Date(ts).getTime(); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
      const cleanText = (raw) => {
        const text = String(raw || "");
        return text
          .replace(/Ã¢â‚¬â„¢/g, "'")
          .replace(/Ã¢â‚¬Å“/g, '"')
          .replace(/Ã¢â‚¬/g, '"')
          .replace(/Ã¢â‚¬"/g, "-")
          .replace(/\u00a0/g, " ");
      };
      const fmtTs = (ts) => {
        if (!ts) return "-";
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return String(ts);
        return d.toLocaleString("fr-FR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      };

      function nonZeroPositions(portfolio) {
        return Object.values(portfolio?.positions || {}).filter((p) => Math.abs(num(p?.net_quantity) || 0) > 0);
      }
      function tradeKey(t) {
        const f = t?.fill || {};
        return [t?.tick_id || "", f.symbol || "", f.executed_at || t?.ts || "", f.side || "", f.quantity || ""].join("|");
      }
      function byId(data, analystId) {
        return (data.agent_views || []).find((v) => v.analyst_id === analystId) || null;
      }
      function rankById(rows, analystId) {
        return rows.find((r) => r.analyst_id === analystId) || null;
      }

      function buildRankingRows(data) {
        const views = data.agent_views || [];
        const viewById = new Map(views.map((v) => [v.analyst_id, v]));
        const raw = (data.competition?.ranking || []).length
          ? (data.competition?.ranking || []).slice()
          : views.map((v) => ({
              analyst_id: v.analyst_id,
              display_name: v.display_name || v.analyst_id,
              portfolio_id: v.portfolio_id,
              equity_usd: v.portfolio?.equity_usd,
              trade_count: v.portfolio?.trade_count || 0,
            }));
        raw.sort((a, b) => (num(b.equity_usd) || -Infinity) - (num(a.equity_usd) || -Infinity));
        return raw.map((r, i) => {
          const view = viewById.get(r.analyst_id) || {};
          const p = view.portfolio || {};
          const initial = num(p.initial_balance_usd);
          const equity = num(r.equity_usd);
          const ret = initial && equity !== null ? ((equity - initial) / initial) * 100 : null;
          const pos = nonZeroPositions(p);
          const gross = pos.reduce((s, x) => s + Math.abs(num(x.notional_exposure_usd) || 0), 0);
          const risk = equity && equity > 0 ? (gross / equity) * 100 : null;
          const d = view.latest_result?.decision || {};
          return { ...r, rank: r.rank || i + 1, return_pct: ret, open_positions: pos.length, risk_pct: risk, last_action: d.action || "-", last_symbol: d.symbol || "", confidence: d.confidence };
        });
      }

      function renderGlobal(rows) {
        const root = document.getElementById("global-kpis");
        if (!rows.length) {
          root.innerHTML = '<div class="card"><div class="k">Status</div><div class="v">No data</div></div>';
          return;
        }
        const totalEq = rows.reduce((s, r) => s + (num(r.equity_usd) || 0), 0);
        const avgRet = rows.reduce((s, r) => s + (num(r.return_pct) || 0), 0) / rows.length;
        const leader = rows[0];
        const openCount = rows.reduce((s, r) => s + (r.open_positions || 0), 0);
        const avgRisk = rows.reduce((s, r) => s + (num(r.risk_pct) || 0), 0) / rows.length;
        const cards = [
          ["Total Equity", fmtM(totalEq), cssSign(avgRet)],
          ["Average Return", fmtSP(avgRet), cssSign(avgRet)],
          ["Leader", esc(leader.display_name || leader.analyst_id || "-"), ""],
          ["Open Positions", String(openCount), openCount > 0 ? "warn" : ""],
          ["Average Risk", fmtP(avgRisk, 1), avgRisk > 100 ? "warn" : ""],
        ];
        root.innerHTML = cards.map(([k, v, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("");
      }

      function renderMarketContext(snapshot) {
        const marketBody = document.getElementById("market-context-body");
        const newsFeed = document.getElementById("news-feed");
        const sentimentBody = document.getElementById("sentiment-body");
        if (!marketBody || !newsFeed || !sentimentBody) return;

        marketBody.innerHTML = "";
        newsFeed.innerHTML = "";
        sentimentBody.innerHTML = "";

        const market = snapshot?.market_data || [];
        const news = snapshot?.news || [];
        const social = snapshot?.social_sentiment || [];

        if (!market.length) {
          marketBody.innerHTML = '<tr><td colspan="4" class="muted">Aucune market data</td></tr>';
        } else {
          for (const row of market.slice(0, 8)) {
            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td>${esc(row.symbol || "-")}</td>
              <td>${fmtM(row.price, 2)}</td>
              <td class="${cssSign((num(row.funding_rate) || 0) * 100)}">${fmtSP((num(row.funding_rate) || 0) * 100, 4)}</td>
              <td>${fmtN(row.open_interest, 0)}</td>
            `;
            marketBody.appendChild(tr);
          }
        }

        if (!news.length) {
          newsFeed.innerHTML = '<li class="muted">Aucune news disponible</li>';
        } else {
          for (const item of news.slice(0, 6)) {
            const s = num(item.sentiment);
            const cls = s === null || s === 0 ? "warn" : s > 0 ? "pos" : "neg";
            const li = document.createElement("li");
            li.innerHTML = `
              <div class="news-headline">${esc(item.headline || "-")}</div>
              <div class="news-meta">
                <span>${esc(item.source || "-")}</span>
                <span class="sent-chip ${cls}">sent: ${fmtSP(s, 3)}</span>
                <span>${fmtTs(item.published_at)}</span>
              </div>
            `;
            newsFeed.appendChild(li);
          }
        }

        if (!social.length) {
          sentimentBody.innerHTML = '<tr><td colspan="4" class="muted">Aucun sentiment social</td></tr>';
        } else {
          const sorted = social
            .slice()
            .sort((a, b) => Math.abs(num(b.score) || 0) - Math.abs(num(a.score) || 0));
          for (const row of sorted.slice(0, 12)) {
            const sc = num(row.score);
            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td>${esc(row.symbol || "-")}</td>
              <td class="${cssSign(sc)}">${fmtSP(sc, 3)}</td>
              <td>${fmtN(row.mentions, 0)}</td>
              <td>${esc(row.platform || "-")}</td>
            `;
            sentimentBody.appendChild(tr);
          }
        }
      }

      function renderRanking(rows) {
        const body = document.getElementById("ranking-body");
        body.innerHTML = "";
        if (!rows.length) {
          body.innerHTML = '<tr><td colspan="8" class="muted">No ranking data</td></tr>';
          return;
        }
        for (const row of rows) {
          const tr = document.createElement("tr");
          if (row.analyst_id === selectedAnalystId) tr.classList.add("selected");
          tr.innerHTML = `
            <td><strong>${row.rank || "-"}</strong></td>
            <td>${esc(row.display_name || row.analyst_id || "-")}</td>
            <td class="${cssSign(row.return_pct)}">${fmtM(row.equity_usd)}</td>
            <td class="${cssSign(row.return_pct)}">${fmtSP(row.return_pct, 2)}</td>
            <td class="${row.risk_pct > 100 ? "warn" : ""}">${fmtP(row.risk_pct, 1)}</td>
            <td>${row.trade_count || 0}</td>
            <td>${esc(String(row.last_action || "-").toUpperCase())} ${esc(row.last_symbol || "")}</td>
            <td>${row.confidence === undefined ? "-" : fmtP((num(row.confidence) || 0) * 100, 1)}</td>`;
          tr.addEventListener("click", () => { selectedAnalystId = row.analyst_id; selectedTradeKey = null; renderAll(); });
          body.appendChild(tr);
        }
      }

      function renderSummary(view, portfolio) {
        const root = document.getElementById("summary-grid");
        const initial = num(portfolio.initial_balance_usd) || 0;
        const equity = num(portfolio.equity_usd) || 0;
        const cash = num(portfolio.cash_balance_usd) || 0;
        const gross = nonZeroPositions(portfolio).reduce((s, p) => s + Math.abs(num(p.notional_exposure_usd) || 0), 0);
        const risk = equity > 0 ? (gross / equity) * 100 : null;
        const ret = initial > 0 ? ((equity - initial) / initial) * 100 : null;
        const d = view.latest_result?.decision || {};
        const cards = [
          ["Equity", fmtM(portfolio.equity_usd), cssSign(ret)],
          ["Return", fmtSP(ret, 2), cssSign(ret)],
          ["Cash", fmtM(cash), ""],
          ["Gross Exposure", fmtM(gross), ""],
          ["Risk / Equity", fmtP(risk, 1), risk > 100 ? "warn" : ""],
          ["Realized PnL", fmtSM(portfolio.realized_pnl_usd), cssSign(portfolio.realized_pnl_usd)],
          ["Unrealized PnL", fmtSM(portfolio.unrealized_pnl_usd), cssSign(portfolio.unrealized_pnl_usd)],
          ["Last Decision", `${String(d.action || "-").toUpperCase()} ${d.symbol || ""}`, d.action === "short" ? "neg" : d.action === "long" ? "pos" : ""],
        ];
        root.innerHTML = cards.map(([k, v, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${esc(v)}</div></div>`).join("");
      }

      function buildAllocation(portfolio) {
        const equity = num(portfolio?.equity_usd) || 0;
        const rows = [];
        const cash = Math.max(0, num(portfolio?.cash_balance_usd) || 0);
        if (cash > 0) rows.push({ label: "Cash", amount: cash, signed: cash });
        for (const p of nonZeroPositions(portfolio)) {
          const qty = num(p.net_quantity) || 0;
          const mark = num(p.mark_price) || 0;
          const signed = qty * mark;
          const amt = Math.abs(num(p.notional_exposure_usd) || signed);
          rows.push({ label: `${p.symbol} ${qty >= 0 ? "long" : "short"}`, amount: amt, signed });
        }
        const total = rows.reduce((s, r) => s + r.amount, 0);
        const gross = nonZeroPositions(portfolio).reduce((s, p) => s + Math.abs(num(p.notional_exposure_usd) || 0), 0);
        return rows.map((r, i) => ({ ...r, color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length], mix_pct: total > 0 ? (r.amount / total) * 100 : 0, equity_pct: equity > 0 ? (r.signed / equity) * 100 : null, total, gross }));
      }

      function renderAllocation(portfolio) {
        const pie = document.getElementById("allocation-pie");
        const center = document.getElementById("allocation-center");
        const body = document.getElementById("allocation-body");
        body.innerHTML = "";
        const rows = buildAllocation(portfolio);
        if (!rows.length || rows[0].total <= 0) {
          pie.style.background = "#e8eff3";
          center.innerHTML = "<strong>No allocation</strong><span>portfolio is flat</span>";
          body.innerHTML = '<tr><td colspan="4" class="muted">No allocation data</td></tr>';
          return;
        }
        let cur = 0;
        const parts = [];
        for (const r of rows) {
          const end = cur + r.mix_pct;
          parts.push(`${r.color} ${cur.toFixed(3)}% ${end.toFixed(3)}%`);
          cur = end;
        }
        pie.style.background = `conic-gradient(${parts.join(", ")})`;
        center.innerHTML = `<strong>${fmtM(rows[0].gross)}</strong><span>gross exposure</span>`;
        for (const r of rows) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td><span class="sw" style="background:${r.color}"></span>${esc(r.label)}</td><td>${fmtM(r.amount)}</td><td>${fmtP(r.mix_pct,1)}</td><td class="${cssSign(r.equity_pct)}">${fmtSP(r.equity_pct,1)}</td>`;
          body.appendChild(tr);
        }
      }

      function renderPositions(portfolio) {
        const body = document.getElementById("positions-body");
        body.innerHTML = "";
        const equity = num(portfolio.equity_usd) || 0;
        const rows = nonZeroPositions(portfolio).sort((a, b) => Math.abs(num(b.notional_exposure_usd) || 0) - Math.abs(num(a.notional_exposure_usd) || 0));
        if (!rows.length) {
          body.innerHTML = '<tr><td colspan="7" class="muted">No open positions</td></tr>';
          return;
        }
        for (const p of rows) {
          const qty = num(p.net_quantity) || 0;
          const eqPct = equity > 0 ? ((qty * (num(p.mark_price) || 0)) / equity) * 100 : null;
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${esc(p.symbol || "-")}</td><td class="${qty > 0 ? "pos" : "neg"}">${qty > 0 ? "LONG" : "SHORT"}</td><td>${fmtN(qty,6)}</td><td>${fmtM(p.mark_price,4)}</td><td>${fmtM(p.notional_exposure_usd)}</td><td class="${cssSign(eqPct)}">${fmtSP(eqPct,1)}</td><td class="${cssSign(p.unrealized_pnl_usd)}">${fmtSM(p.unrealized_pnl_usd)}</td>`;
          body.appendChild(tr);
        }
      }

      function buildEqSeries(view) {
        const out = [];
        for (const r of view.equity_history || []) {
          const t = toUnix(r.ts);
          const v = num(r.equity_usd);
          if (t !== null && v !== null) out.push({ time: t, value: v });
        }
        out.sort((a, b) => a.time - b.time);
        return out;
      }

      function renderEquity(view) {
        const c = document.getElementById("equity-chart");
        if (!window.LightweightCharts) { c.innerHTML = '<div class="empty">Chart library unavailable</div>'; return; }
        if (equityChart) { equityChart.remove(); equityChart = null; }
        equityChart = LightweightCharts.createChart(c, { width: c.clientWidth || 420, height: c.clientHeight || 280, layout: { background: { color: "#fff" }, textColor: "#4d606e" }, rightPriceScale: { borderColor: "#d3dde4" }, timeScale: { borderColor: "#d3dde4", timeVisible: true }, grid: { vertLines: { color: "#ecf2f6" }, horzLines: { color: "#ecf2f6" } } });
        const s = equityChart.addAreaSeries({ topColor: "rgba(14,124,102,.3)", bottomColor: "rgba(14,124,102,.03)", lineColor: "#0e7c66", lineWidth: 2 });
        const d = buildEqSeries(view);
        if (d.length) { s.setData(d); equityChart.timeScale().fitContent(); }
      }

      function buildCandlesFromCloses(closes) {
        if (!Array.isArray(closes) || closes.length < 2) {
          return [];
        }
        const candles = [];
        for (let i = 1; i < closes.length; i += 1) {
          const prev = closes[i - 1];
          const current = closes[i];
          const open = prev.value;
          const close = current.value;
          candles.push({
            time: current.time,
            open,
            high: Math.max(open, close),
            low: Math.min(open, close),
            close,
          });
        }
        return candles;
      }

      function buildTradeWindowData(marketHistory, trades, symbol, targetUnix) {
        const market = [];
        for (const row of marketHistory || []) {
          const t = toUnix(row.as_of);
          const v = num(row?.prices?.[symbol]);
          if (t !== null && v !== null) market.push({ time: t, value: v });
        }
        market.sort((a, b) => a.time - b.time);
        let series = market;
        if (series.length < 3) {
          const synthetic = [];
          for (const tr of trades || []) {
            const f = tr.fill || {};
            if (f.symbol !== symbol) continue;
            const t = toUnix(f.executed_at || tr.ts);
            const v = num(f.executed_price);
            if (t !== null && v !== null) synthetic.push({ time: t, value: v });
          }
          synthetic.sort((a, b) => a.time - b.time);
          series = synthetic;
        }
        if (!series.length) {
          return {
            closes: [],
            candles: [],
            source: "none",
            barsBefore: 0,
            barsAfter: 0,
            preMovePct: null,
            postMovePct: null,
          };
        }

        if (targetUnix === null) {
          const fallbackStart = Math.max(0, series.length - (TRADE_WINDOW_BEFORE_POINTS + TRADE_WINDOW_AFTER_POINTS));
          const closes = series.slice(fallbackStart);
          return {
            closes,
            candles: buildCandlesFromCloses(closes),
            source: market.length >= 3 ? "market_history" : "synthetic_trades",
            barsBefore: Math.max(0, closes.length - 1),
            barsAfter: 0,
            preMovePct: null,
            postMovePct: null,
          };
        }

        let best = 0, dist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < series.length; i += 1) {
          const d = Math.abs(series[i].time - targetUnix);
          if (d < dist) { dist = d; best = i; }
        }

        const start = Math.max(0, best - TRADE_WINDOW_BEFORE_POINTS);
        const end = Math.min(series.length, best + TRADE_WINDOW_AFTER_POINTS + 1);
        const closes = series.slice(start, end);
        const selectedIndex = best - start;
        const barsBefore = Math.max(0, selectedIndex);
        const barsAfter = Math.max(0, closes.length - selectedIndex - 1);

        let preMovePct = null;
        let postMovePct = null;
        const selected = closes[selectedIndex];
        if (selected && selected.value > 0) {
          const preIndex = Math.max(0, selectedIndex - TRADE_CONTEXT_BARS);
          const postIndex = Math.min(closes.length - 1, selectedIndex + TRADE_CONTEXT_BARS);
          const preRef = closes[preIndex];
          const postRef = closes[postIndex];
          if (preRef && preRef.value > 0) {
            preMovePct = ((selected.value - preRef.value) / preRef.value) * 100;
          }
          if (postRef && selected.value > 0 && postIndex > selectedIndex) {
            postMovePct = ((postRef.value - selected.value) / selected.value) * 100;
          }
        }

        return {
          closes,
          candles: buildCandlesFromCloses(closes),
          source: market.length >= 3 ? "market_history" : "synthetic_trades",
          barsBefore,
          barsAfter,
          preMovePct,
          postMovePct,
        };
      }

      function codexExplanation(decisionRow, trade, fallback) {
        if (String(trade?.decision_explanation || "").trim()) return String(trade.decision_explanation).trim();
        const codex = decisionRow?.codex || {};
        if (String(codex.explanation || "").trim()) return String(codex.explanation).trim();
        const payload = codex.response_payload || {};
        const parts = [];
        if (payload.reason) parts.push(String(payload.reason));
        const a = payload.analysis;
        if (a && typeof a === "object") {
          if (a.thesis) parts.push(`Thesis: ${a.thesis}`);
          if (a.signals) parts.push(`Signals: ${Array.isArray(a.signals) ? a.signals.join("; ") : String(a.signals)}`);
          if (a.risk) parts.push(`Risk: ${a.risk}`);
          if (a.invalidation) parts.push(`Invalidation: ${a.invalidation}`);
        }
        return parts.length ? parts.join("\n\n") : (fallback || "No explanation available");
      }

      function renderTradeFocus(view, trade, byTick, marketHistory) {
        const root = document.getElementById("trade-focus");
        const meta = document.getElementById("trade-meta");
        const reasonEl = document.getElementById("trade-reason");
        const codexEl = document.getElementById("trade-codex");
        const codexMeta = document.getElementById("trade-codex-meta");
        const codexJson = document.getElementById("trade-codex-json");
        const chartEl = document.getElementById("trade-chart");
        if (!trade) { root.style.display = "none"; return; }

        const fill = trade.fill || {};
        const drow = byTick.get(trade.tick_id) || {};
        const decision = drow.decision || {};
        const side = String(fill.side || "-").toUpperCase();
        const symbol = fill.symbol || decision.symbol || "-";
        const px = num(fill.executed_price);
        const qty = num(fill.quantity) || 0;
        const conf = trade.decision_confidence ?? decision.confidence;
        const tokens = drow?.codex?.token_usage ?? trade.codex_token_usage ?? null;
        const logPath = drow?.codex?.log_path || "";
        const mark = num((view.portfolio?.positions || {})[symbol]?.mark_price);
        const pnl = px !== null && mark !== null ? (mark - px) * qty * (side === "BUY" ? 1 : -1) : null;
        const windowData = buildTradeWindowData(marketHistory, view.trades || [], symbol, toUnix(fill.executed_at || trade.ts));
        const cards = [
          ["Trade", `${side} ${symbol}`, side === "BUY" ? "pos" : side === "SELL" ? "neg" : ""],
          ["Transition", trade.transition || "-", ""],
          ["Executed", fmtTs(fill.executed_at || trade.ts), ""],
          ["Price", fmtM(px, 4), ""],
          ["Quantity", fmtN(qty, 6), ""],
          ["Notional", fmtM(fill.notional_usd), ""],
          ["Confidence", conf === undefined ? "-" : fmtP((num(conf) || 0) * 100, 1), ""],
          ["PnL vs Mark", fmtSM(pnl), cssSign(pnl)],
          ["Bougies avant", String(windowData.barsBefore), ""],
          ["Bougies apres", String(windowData.barsAfter), ""],
          [`Contexte -${TRADE_CONTEXT_BARS}`, fmtSP(windowData.preMovePct, 2), cssSign(windowData.preMovePct)],
          [`Contexte +${TRADE_CONTEXT_BARS}`, fmtSP(windowData.postMovePct, 2), cssSign(windowData.postMovePct)],
        ];
        meta.innerHTML = cards.map(([k, v, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${esc(v)}</div></div>`).join("");

        const fallback = trade.decision_reason || decision.reason || "No decision reason";
        reasonEl.textContent = cleanText(fallback);
        codexEl.textContent = cleanText(codexExplanation(drow, trade, fallback));
        codexMeta.textContent = [
          tokens !== null && tokens !== undefined ? `Tokens: ${tokens}` : "",
          windowData.source === "market_history" ? "Source chart: market_history" : "Source chart: trades",
          logPath ? `Log: ${logPath}` : "",
        ].filter(Boolean).join(" | ");
        codexJson.textContent = drow?.codex?.response_payload ? JSON.stringify(drow.codex.response_payload, null, 2) : "No payload";
        root.style.display = "block";

        if (!window.LightweightCharts) { chartEl.innerHTML = '<div class="empty">Chart library unavailable</div>'; return; }
        if (tradeChart) { tradeChart.remove(); tradeChart = null; }
        tradeChart = LightweightCharts.createChart(chartEl, { width: chartEl.clientWidth || 600, height: chartEl.clientHeight || 280, layout: { background: { color: "#fff" }, textColor: "#4d606e" }, rightPriceScale: { borderColor: "#d3dde4" }, timeScale: { borderColor: "#d3dde4", timeVisible: true }, grid: { vertLines: { color: "#ecf2f6" }, horzLines: { color: "#ecf2f6" } } });
        const candleSeries = tradeChart.addCandlestickSeries({
          upColor: "#0e7c66",
          downColor: "#b3263a",
          wickUpColor: "#0e7c66",
          wickDownColor: "#b3263a",
          borderVisible: false,
        });
        const allTrades = view.trades || [];
        const candles = windowData.candles;
        if (!candles.length) { chartEl.innerHTML = '<div class="empty">Pas assez de contexte prix pour afficher les bougies</div>'; return; }
        candleSeries.setData(candles);
        tradeChart.timeScale().fitContent();
        if (px !== null && typeof candleSeries.createPriceLine === "function") {
          candleSeries.createPriceLine({
            price: px,
            color: side === "BUY" ? "#0e7c66" : "#b3263a",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "entree",
          });
        }

        const minT = candles[0].time, maxT = candles[candles.length - 1].time;
        const marks = [];
        for (const row of allTrades) {
          const f = row.fill || {};
          if (f.symbol !== symbol) continue;
          const t = toUnix(f.executed_at || row.ts);
          if (t === null || t < minT || t > maxT) continue;
          const sSide = String(f.side || "").toUpperCase();
          const selected = tradeKey(row) === tradeKey(trade);
          marks.push({
            time: t,
            position: sSide === "BUY" ? "belowBar" : "aboveBar",
            color: selected ? "#1f2937" : (sSide === "BUY" ? "#0e7c66" : "#b3263a"),
            shape: sSide === "BUY" ? "arrowUp" : "arrowDown",
            text: selected ? `ENTREE ${sSide}` : sSide,
          });
        }
        if (typeof candleSeries.setMarkers === "function") candleSeries.setMarkers(marks);
      }

      function renderTrades(view, marketHistory) {
        const body = document.getElementById("trades-body");
        body.innerHTML = "";
        const trades = (view.trades || []).slice(-TRADE_HISTORY_LIMIT).reverse();
        const byTick = new Map((view.decisions || []).map((r) => [r.tick_id, r]));
        if (!trades.length) {
          body.innerHTML = '<tr><td colspan="9" class="muted">No executed trade yet</td></tr>';
          renderTradeFocus(view, null, byTick, marketHistory);
          return;
        }
        for (const trd of trades) {
          const fill = trd.fill || {};
          const drow = byTick.get(trd.tick_id) || {};
          const decision = drow.decision || {};
          const key = tradeKey(trd);
          const side = String(fill.side || "-").toUpperCase();
          const row = document.createElement("tr");
          if (key === selectedTradeKey) row.classList.add("active");
          row.innerHTML = `<td>${fmtTs(fill.executed_at || trd.ts)}</td><td>${esc(fill.symbol || "-")}</td><td class="${side === "BUY" ? "buy" : side === "SELL" ? "sell" : ""}">${side}</td><td>${esc(trd.transition || "-")}</td><td>${decision.allocation_pct === undefined ? "-" : fmtP((num(decision.allocation_pct) || 0) * 100, 1)}</td><td>${trd.decision_confidence === undefined ? "-" : fmtP((num(trd.decision_confidence) || 0) * 100, 1)}</td><td>${fmtM(fill.executed_price, 4)}</td><td>${fmtM(fill.notional_usd)}</td><td>${fmtM(fill.fee_paid_usd, 4)}</td>`;
          row.addEventListener("click", () => { selectedTradeKey = key; renderAll(); });
          body.appendChild(row);
        }
        const selected = trades.find((x) => tradeKey(x) === selectedTradeKey) || trades[0];
        if (selected && !selectedTradeKey) selectedTradeKey = tradeKey(selected);
        renderTradeFocus(view, selected, byTick, marketHistory);
      }

      function renderSelected(data, rows) {
        const empty = document.getElementById("detail-empty");
        const root = document.getElementById("detail-root");
        if (!selectedAnalystId) { empty.style.display = "block"; root.style.display = "none"; return; }
        const view = byId(data, selectedAnalystId);
        const rank = rankById(rows, selectedAnalystId);
        if (!view || !rank) { empty.style.display = "block"; root.style.display = "none"; return; }
        const p = view.portfolio || {};
        const d = view.latest_result?.decision || {};
        empty.style.display = "none";
        root.style.display = "block";
        document.getElementById("detail-name").textContent = view.display_name || view.analyst_id || "-";
        document.getElementById("detail-sub").innerHTML = `id: <span class="mono">${esc(view.analyst_id || "-")}</span> | portfolio: <span class="mono">${esc(view.portfolio_id || p.portfolio_id || "-")}</span> | tick: <span class="mono">${esc(view.latest_result?.tick_id || data.competition?.tick_id || "-")}</span>`;
        document.getElementById("detail-rank").textContent = `Rank #${rank.rank || "-"}`;
        document.getElementById("detail-last").textContent = `Decision ${String(d.action || "-").toUpperCase()} ${d.symbol || ""}`;
        renderSummary(view, p);
        renderAllocation(p);
        renderPositions(p);
        renderEquity(view);
        renderTrades(view, data.market_history || []);
      }

      function renderAll() {
        if (!stateCache) return;
        const rows = buildRankingRows(stateCache);
        renderGlobal(rows);
        renderMarketContext(stateCache.snapshot);
        if (!selectedAnalystId && rows.length) selectedAnalystId = rows[0].analyst_id;
        if (selectedAnalystId && !rows.some((r) => r.analyst_id === selectedAnalystId)) { selectedAnalystId = rows.length ? rows[0].analyst_id : null; selectedTradeKey = null; }
        renderRanking(rows);
        renderSelected(stateCache, rows);
      }

      async function loadState() {
        try {
          const res = await fetch("./data/system_state.json", { cache: "no-store" });
          if (!res.ok) { document.getElementById("updated-at").textContent = "State file not found"; return; }
          stateCache = await res.json();
          const updated = fmtTs(stateCache.updated_at);
          const tick = stateCache.snapshot?.tick_id || stateCache.competition?.tick_id || "-";
          document.getElementById("updated-at").textContent = `${updated} | tick ${tick}`;
          renderAll();
        } catch (err) {
          document.getElementById("updated-at").textContent = `Load error: ${err.message}`;
        }
      }

      window.addEventListener("resize", () => {
        if (equityChart) { const c = document.getElementById("equity-chart"); equityChart.resize(c.clientWidth || 420, c.clientHeight || 280); }
        if (tradeChart) { const c = document.getElementById("trade-chart"); tradeChart.resize(c.clientWidth || 600, c.clientHeight || 280); }
      });

      loadState();
      setInterval(loadState, REFRESH_MS);
