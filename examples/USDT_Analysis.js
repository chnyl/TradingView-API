const TradingView = require('../main');

// Helper to translate TradingView recommendation values to human-readable strings
function getRecommendationText(value) {
  if (value === undefined || value === null) return 'N/A';
  if (value <= -0.5) return '🔴 STRONG SELL';
  if (value > -0.5 && value <= -0.1) return '🔴 SELL';
  if (value > -0.1 && value < 0.1) return '⚪ NEUTRAL';
  if (value >= 0.1 && value < 0.5) return '🟢 BUY';
  return '🟢 STRONG BUY';
}

async function analyzeMarket(symbol) {
  console.log(`\n==================================================`);
  console.log(`Analyzing: ${symbol}...`);
  console.log(`==================================================`);

  // 1. Fetch Technical Analysis data from the scanner
  try {
    const ta = await TradingView.getTA(symbol);
    if (!ta) {
      console.log(`❌ Failed to retrieve TA data for ${symbol}.`);
    } else {
      console.log(`\n[Technical Analysis Recommendations]`);
      const targetTimeframes = ['15', '60', '1D']; // 15m, 1h, 1 day

      targetTimeframes.forEach((tf) => {
        const data = ta[tf];
        if (data) {
          const tfLabel = tf === '1D' ? '1 Day' : `${tf}m`;
          console.log(`\nTimeframe: ${tfLabel}`);
          console.log(`  - Overall:      ${getRecommendationText(data.All)} (${data.All})`);
          console.log(`  - Moving Avg:   ${getRecommendationText(data.MA)} (${data.MA})`);
          console.log(`  - Oscillators:  ${getRecommendationText(data.Other)} (${data.Other})`);
        }
      });
    }
  } catch (error) {
    console.error('Error fetching TA:', error.message);
  }

  // 2. Fetch real-time price using the WebSocket client
  return new Promise((resolve) => {
    const client = new TradingView.Client();
    const chart = new client.Session.Chart();

    chart.setMarket(symbol, {
      timeframe: 'D',
    });

    chart.onError((err) => {
      console.error(`[WebSocket Error] ${symbol}:`, err);
      client.end();
      resolve();
    });

    chart.onSymbolLoaded(() => {
      console.log(`\n[Realtime WebSocket] Connected to ${chart.infos.description}`);
    });

    let updatesReceived = 0;
    chart.onUpdate(() => {
      if (!chart.periods[0]) return;
      const currentPrice = chart.periods[0].close;
      const currency = chart.infos.currency_id || 'USDT';

      console.log(`🔥 [Realtime Price Update] ${chart.infos.description}: ${currentPrice} ${currency}`);

      updatesReceived++;
      // Once we get a couple of real-time price ticks, we close the session
      if (updatesReceived >= 2) {
        chart.delete();
        client.end();
        resolve();
      }
    });
  });
}

async function main() {
  await analyzeMarket('BINANCE:BTCUSDT');
  await analyzeMarket('BINANCE:ETHUSDT');
  console.log(`\n==================================================`);
  console.log('Analysis finished.');
  console.log(`==================================================\n`);
}

main();
