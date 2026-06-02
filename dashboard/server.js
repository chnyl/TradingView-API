const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const TradingView = require('../main');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Shared Client ────────────────────────────────────────────────────────────
const client = new TradingView.Client();

// ─── Subscriptions State ──────────────────────────────────────────────────────
// Maps symbolId -> { chart, subscribers: Set(wsClient), lastPriceData, taData }
const activeSymbols = {};

function getRecommendation(value) {
  if (value === undefined || value === null) return { label: 'N/A', score: 0 };
  if (value <= -0.5)  return { label: 'STRONG SELL', score: value };
  if (value <= -0.1)  return { label: 'SELL',        score: value };
  if (value <   0.1)  return { label: 'NEUTRAL',     score: value };
  if (value <   0.5)  return { label: 'BUY',         score: value };
  return               { label: 'STRONG BUY',          score: value };
}

// ─── Fetch TA on demand ───────────────────────────────────────────────────────
async function fetchTA(symbolId) {
  try {
    const ta = await TradingView.getTA(symbolId);
    if (ta && activeSymbols[symbolId]) {
      const formatted = {};
      ['15', '60', '1D'].forEach((tf) => {
        if (ta[tf]) {
          formatted[tf] = {
            overall: getRecommendation(ta[tf].All),
            ma:      getRecommendation(ta[tf].MA),
            osc:     getRecommendation(ta[tf].Other),
          };
        }
      });
      activeSymbols[symbolId].taData = formatted;
      broadcastToSymbol(symbolId, { type: 'ta_update', symbol: symbolId, ta: formatted });
      console.log(`[TA] Fetched for ${symbolId}`);
    }
  } catch (e) {
    console.error(`[TA] Error fetching for ${symbolId}:`, e.message);
  }
}

// ─── Subscribe to symbol ──────────────────────────────────────────────────────
function subscribeSymbol(symbolId, wsClient) {
  if (activeSymbols[symbolId]) {
    // Already active, just add subscriber
    activeSymbols[symbolId].subscribers.add(wsClient);
    // Send immediate current cache if exists
    if (activeSymbols[symbolId].lastPriceData) {
      wsClient.send(JSON.stringify({
        type: 'price_update',
        symbol: symbolId,
        ...activeSymbols[symbolId].lastPriceData,
      }));
    }
    if (activeSymbols[symbolId].taData) {
      wsClient.send(JSON.stringify({
        type: 'ta_update',
        symbol: symbolId,
        ta: activeSymbols[symbolId].taData,
      }));
    }
    return;
  }

  // Set up new chart session
  console.log(`[WS] Creating new chart session for ${symbolId}...`);
  try {
    const chart = new client.Session.Chart();
    chart.setMarket(symbolId, { timeframe: 'D' });

    activeSymbols[symbolId] = {
      chart,
      subscribers: new Set([wsClient]),
      lastPriceData: null,
      taData: null,
    };

    chart.onError((...err) => {
      console.error(`[WS] Error for ${symbolId}:`, ...err);
    });

    chart.onSymbolLoaded(() => {
      console.log(`[WS] Loaded: ${symbolId}`);
      broadcastToSymbol(symbolId, { type: 'status', symbol: symbolId, connected: true });
    });

    chart.onUpdate(() => {
      if (!activeSymbols[symbolId]) return;

      const periods = chart.periods;
      if (!periods || !periods[0]) return;

      const current = periods[0];
      const prevPrice = activeSymbols[symbolId].lastPriceData?.price || null;
      let change24h = null;

      if (current.open && current.close) {
        change24h = ((current.close - current.open) / current.open) * 100;
      }

      const priceData = {
        price:     current.close,
        prevPrice: prevPrice,
        change24h: change24h,
        high24h:   current.high,
        low24h:    current.low,
        volume:    current.volume,
        description: chart.infos.description || symbolId.split(':').pop(),
      };

      activeSymbols[symbolId].lastPriceData = priceData;

      broadcastToSymbol(symbolId, {
        type: 'price_update',
        symbol: symbolId,
        ...priceData,
      });
    });

    // Fetch initial TA data
    fetchTA(symbolId);

  } catch (e) {
    console.error(`[WS] Failed to subscribe to ${symbolId}:`, e.message);
  }
}

// ─── Unsubscribe from symbol ──────────────────────────────────────────────────
function unsubscribeSymbol(symbolId, wsClient) {
  const active = activeSymbols[symbolId];
  if (!active) return;

  active.subscribers.delete(wsClient);
  if (active.subscribers.size === 0) {
    console.log(`[WS] Closing unused session for ${symbolId}`);
    try {
      active.chart.delete();
    } catch (e) {
      console.error(`[WS] Error deleting chart for ${symbolId}:`, e.message);
    }
    delete activeSymbols[symbolId];
  }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────
function broadcastToSymbol(symbolId, data) {
  const active = activeSymbols[symbolId];
  if (!active) return;

  const payload = JSON.stringify(data);
  active.subscribers.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ─── Client connection logic ──────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS Server] Browser client connected');

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'subscribe') {
        const symbol = msg.symbol.toUpperCase();
        subscribeSymbol(symbol, ws);
      }

      if (msg.type === 'unsubscribe') {
        const symbol = msg.symbol.toUpperCase();
        unsubscribeSymbol(symbol, ws);
      }
    } catch (e) {
      console.error('[WS Message Error] Parsing error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS Server] Browser client disconnected');
    // Remove client from all active subscriptions
    Object.keys(activeSymbols).forEach((symbolId) => {
      unsubscribeSymbol(symbolId, ws);
    });
  });
});

// Periodic TA refresh for active symbols (every 5 minutes)
setInterval(() => {
  Object.keys(activeSymbols).forEach((symbolId) => {
    fetchTA(symbolId);
  });
}, 5 * 60 * 1000);

const PORT = 3030;
server.listen(PORT, () => {
  console.log(`\n🚀 Dashboard server running at http://localhost:${PORT}\n`);
});
