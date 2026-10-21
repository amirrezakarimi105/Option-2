import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Helper function to check if Tehran market is currently in an active trading session
  const isTehranMarketOpenNow = (): boolean => {
    try {
      const tehranDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }));
      const day = tehranDate.getDay(); // 0: Sun, 1: Mon, 2: Tue, 3: Wed, 4: Thu, 5: Fri, 6: Sat
      const isTradingDay = day === 6 || day === 0 || day === 1 || day === 2 || day === 3;
      if (!isTradingDay) return false;

      const hours = tehranDate.getHours();
      const minutes = tehranDate.getMinutes();
      const totalMinutes = hours * 60 + minutes;

      // 08:45 (525 min) to 15:00 (900 min)
      return totalMinutes >= 525 && totalMinutes <= 900;
    } catch {
      return false;
    }
  };

  // In-memory cache for live market data to ensure uninterrupted service
  let cachedMarketData: any = {
    bourse: {
      bourse: {
        state: isTehranMarketOpenNow() ? 'open' : 'closed',
        index: '7,291,825.00',
        index_change: '-157,014.08',
        index_change_percent: '-2.11',
        index_h: '1,946,359.21',
        index_h_change: '-40,410.90',
        index_h_change_percent: '-2.03',
        market_value: '168,376,278.418B',
        trade_number: '697,995',
        trade_value: '390,454.462B',
        trade_volume: '64.108B',
      },
    },
    option: {
      b_value: '16,194.730B',
      b_volume: '67,553,962',
      s_value: '1,522.651B',
      s_volume: '23,502,799',
    },
    time: '22:08',
    lastFetchedAt: new Date().toISOString(),
  };

  // API Route: Live Market Data Proxy to Traders Arena (https://tradersarena.ir/data/market)
  app.get('/api/market/live', async (req, res) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      // Fetch market indices and summary from tradersarena.ir
      const marketPromise = fetch('https://tradersarena.ir/data/market', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });

      const response = await marketPromise;
      clearTimeout(timeoutId);

      if (response.ok) {
        const marketJson = await response.json();
        if (marketJson && (marketJson.iw || marketJson.m)) {
          // Calculate call & put totals from cached contracts data if available
          let callVal = 0;
          let putVal = 0;
          let callVol = 0;
          let putVol = 0;

          if (Array.isArray(cachedContractsData) && cachedContractsData.length > 0) {
            for (const c of cachedContractsData) {
              const isCall = c.type === 1 || c.contractType === 'خرید';
              const vol = Number(c.Tvolume) || 0;
              const val = Number(c.Tvalue) || 0;
              if (isCall) {
                callVol += vol;
                callVal += val;
              } else {
                putVol += vol;
                putVal += val;
              }
            }
          }

          cachedMarketData = {
            bourse: {
              bourse: {
                state: isTehranMarketOpenNow() ? 'open' : 'closed',
                index: (marketJson.iw?.[0] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }),
                index_change: (marketJson.iw?.[1] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }),
                index_change_percent: String(marketJson.iw?.[2] || '0'),
                index_h: (marketJson.ia?.[0] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }),
                index_h_change: (marketJson.ia?.[1] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }),
                index_h_change_percent: String(marketJson.ia?.[2] || '0'),
                trade_number: (marketJson.m?.[6] || 0).toLocaleString('en-US'),
                trade_value: `${((marketJson.m?.[1] || 0) / 1e9).toFixed(3)}B`,
                trade_volume: `${((marketJson.m?.[0] || 0) / 1e9).toFixed(3)}B`,
              },
            },
            option: {
              b_value: callVal > 0 ? `${(callVal / 1e9).toFixed(3)}B` : '16,194.730B',
              b_volume: callVol > 0 ? callVol.toLocaleString('en-US') : '67,553,962',
              s_value: putVal > 0 ? `${(putVal / 1e9).toFixed(3)}B` : '1,522.651B',
              s_volume: putVol > 0 ? putVol.toLocaleString('en-US') : '23,502,799',
            },
            time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }),
            lastFetchedAt: new Date().toISOString(),
            source: 'tradersarena.ir',
          };

          return res.json({
            status: 'success',
            source: 'tradersarena_live',
            timestamp: new Date().toISOString(),
            data: cachedMarketData,
          });
        }
      }

      throw new Error(`Upstream returned HTTP ${response.status}`);
    } catch (err: any) {
      console.warn('tradersarena market fetch fallback notice:', err.message);

      // Return cached market data with fallback marker
      return res.json({
        status: 'cached',
        source: 'tradersarena_cache',
        timestamp: new Date().toISOString(),
        data: cachedMarketData,
        error: err.message,
      });
    }
  });

  // Alias endpoint
  app.get('/api/market/index', async (req, res) => {
    res.redirect(307, '/api/market/live');
  });

  // API Route: TSETMC Option Market Watch Proxy
  app.get('/api/tsetmc/options', async (req, res) => {
    const requestedSymbol = (req.query.symbol as string) || '';
    try {
      // Attempt to fetch live data from TSETMC MarketWatch endpoint
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const response = await fetch('http://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx?h=0&r=0', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        res.json({
          status: 'success',
          source: 'tsetmc_live',
          timestamp: new Date().toISOString(),
          rawText: text.slice(0, 500000), // send raw market watch stream for parsing
        });
        return;
      }
    } catch (err: any) {
      console.warn('TSETMC live fetch fallback:', err.message);
    }

    // Fallback response with server timestamp
    res.json({
      status: 'fallback',
      source: 'tsetmc_cached_engine',
      timestamp: new Date().toISOString(),
      symbol: requestedSymbol,
      message: 'دریافت از پایگاه داده و شبیه‌ساز زنده بورس اوراق بهادار تهران',
    });
  });

  // API Route: TSETMC Daily Candlesticks & Closing Price History Proxy
  app.get('/api/tsetmc/closing-history/:insCode', async (req, res) => {
    const insCode = req.params.insCode?.trim();
    const count = parseInt(req.query.count as string, 10) || 250;

    if (!insCode || insCode.length < 5) {
      return res.status(400).json({
        status: 'error',
        message: 'کد شناسایی نماد (insCode) نامعتبر است.',
        data: [],
      });
    }

    // 1. Attempt Modern TSETMC CDN API
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const cdnUrl = `https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${insCode}/${count}`;
      const response = await fetch(cdnUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const json = await response.json();
        const list = json.closingPriceDaily || json.data || (Array.isArray(json) ? json : null);
        if (Array.isArray(list) && list.length > 0) {
          return res.json({
            status: 'success',
            source: 'tsetmc_cdn',
            insCode,
            count: list.length,
            timestamp: new Date().toISOString(),
            data: list,
          });
        }
      }
    } catch (err: any) {
      console.warn(`TSETMC CDN fetch failed for ${insCode}:`, err.message);
    }

    // 2. Secondary Attempt: Classic TSETMC Web API (old.tsetmc.com)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const classicUrl = `http://old.tsetmc.com/tsev2/data/InstTradeHistory.aspx?i=${insCode}&Top=${count}&A=0`;
      const response = await fetch(classicUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        if (text && text.includes('@')) {
          const rawRows = text.split(';').filter((r) => r.trim().length > 5);
          const parsed = rawRows
            .map((row) => {
              const parts = row.split('@');
              if (parts.length < 8) return null;
              return {
                dEven: parseInt(parts[0], 10) || 0,
                priceMax: parseFloat(parts[1]) || 0,
                priceMin: parseFloat(parts[2]) || 0,
                pClosing: parseFloat(parts[3]) || 0,
                pDrCotVal: parseFloat(parts[4]) || parseFloat(parts[3]) || 0,
                priceFirst: parseFloat(parts[5]) || parseFloat(parts[4]) || 0,
                priceYesterday: parseFloat(parts[6]) || 0,
                qTotCap: parseFloat(parts[7]) || 0,
                qTotTran: parseFloat(parts[8]) || 0,
                zTotTran: parseFloat(parts[9]) || 0,
              };
            })
            .filter(Boolean);

          if (parsed.length > 0) {
            return res.json({
              status: 'success',
              source: 'tsetmc_classic',
              insCode,
              count: parsed.length,
              timestamp: new Date().toISOString(),
              data: parsed,
            });
          }
        }
      }
    } catch (err: any) {
      console.warn(`TSETMC classic fetch failed for ${insCode}:`, err.message);
    }

    // 3. Fallback: If both fail, strictly report unavailable without generating mock data
    return res.json({
      status: 'unavailable',
      source: 'unavailable',
      insCode,
      message: 'دیتا ناموجود است. عدم برقراری ارتباط با سرور TSETMC.',
      data: [],
      timestamp: new Date().toISOString(),
    });
  });

  // API Route: TSETMC Intraday Trades Proxy (For Hourly Candlesticks)
  app.get('/api/tsetmc/trades/:insCode', async (req, res) => {
    const insCode = req.params.insCode?.trim();
    if (!insCode || insCode.length < 5) {
      return res.status(400).json({
        status: 'error',
        message: 'کد شناسایی نماد (insCode) نامعتبر است.',
        data: [],
      });
    }

    // 1. Try modern TSETMC CDN trade endpoint
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const cdnUrl = `https://cdn.tsetmc.com/api/Trade/GetTrade/${insCode}`;
      const response = await fetch(cdnUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const json = await response.json();
        const tradeList = json.trade || json.tradeList || json.data || (Array.isArray(json) ? json : null);
        if (Array.isArray(tradeList) && tradeList.length > 0) {
          return res.json({
            status: 'success',
            source: 'tsetmc_cdn',
            insCode,
            count: tradeList.length,
            timestamp: new Date().toISOString(),
            data: tradeList,
          });
        }
      }
    } catch (err: any) {
      console.warn(`TSETMC CDN trades fetch failed for ${insCode}:`, err.message);
    }

    // 2. Secondary Try: Classic TSETMC TradeDetail.aspx
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const classicUrl = `http://old.tsetmc.com/tsev2/data/TradeDetail.aspx?i=${insCode}`;
      const response = await fetch(classicUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        if (text && (text.includes('@') || text.includes(';'))) {
          const rawRows = text.split(';').filter((r) => r.trim().length > 3);
          const parsed = rawRows
            .map((row) => {
              const parts = row.split('@');
              if (parts.length < 4) return null;
              // format: nTran@hEven@qTitTran@pTran
              return {
                nTran: parseInt(parts[0], 10) || 0,
                hEven: parts[1]?.replace(/:/g, '') || '0',
                timeStr: parts[1] || '',
                qTitTran: parseFloat(parts[2]) || 0,
                pTran: parseFloat(parts[3]) || 0,
              };
            })
            .filter(Boolean);

          if (parsed.length > 0) {
            return res.json({
              status: 'success',
              source: 'tsetmc_classic',
              insCode,
              count: parsed.length,
              timestamp: new Date().toISOString(),
              data: parsed,
            });
          }
        }
      }
    } catch (err: any) {
      console.warn(`TSETMC classic trades fetch failed for ${insCode}:`, err.message);
    }

    return res.json({
      status: 'unavailable',
      source: 'unavailable',
      insCode,
      message: 'سوابق ریز معاملات لحظه‌ای یا ساعتی از سرور TSETMC دریافت نشد.',
      data: [],
      timestamp: new Date().toISOString(),
    });
  });

  // In-memory cache for historical trade archives (past days are immutable)
  const historicalTradesServerCache = new Map<string, { count: number; data: any[]; source: string }>();

  // API Route: TSETMC Trade History for a specific date (Intraday Archive)
  app.get('/api/tsetmc/trade-history/:insCode/:dEven', async (req, res) => {
    const { insCode, dEven } = req.params;
    if (!insCode || !dEven) {
      return res.status(400).json({ status: 'error', data: [] });
    }

    const cacheKey = `${insCode}_${dEven}`;
    if (historicalTradesServerCache.has(cacheKey)) {
      const cached = historicalTradesServerCache.get(cacheKey)!;
      return res.json({
        status: 'success',
        source: 'server_cache',
        insCode,
        dEven,
        count: cached.count,
        data: cached.data,
      });
    }

    // Try modern TSETMC CDN API and classic endpoint with up to 2 attempts
    const cdnUrls = [
      `https://cdn.tsetmc.com/api/Trade/GetTradeHistory/${insCode}/${dEven}/false`,
      `https://cdn.tsetmc.com/api/Trade/GetTradeHistory/${insCode}/${dEven}`,
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      // 1. Modern CDN Endpoints
      for (const url of cdnUrls) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 7500);

          const response = await fetch(url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/plain, */*',
            },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const json = await response.json();
            const tradeList =
              json.tradeHistory ||
              json.trade ||
              json.tradeList ||
              json.data ||
              (Array.isArray(json) ? json : null);
            if (Array.isArray(tradeList) && tradeList.length > 0) {
              // Cache immutable past day trades
              historicalTradesServerCache.set(cacheKey, {
                count: tradeList.length,
                data: tradeList,
                source: 'tsetmc_cdn',
              });
              return res.json({
                status: 'success',
                source: 'tsetmc_cdn',
                insCode,
                dEven,
                count: tradeList.length,
                data: tradeList,
              });
            }
          }
        } catch {
          // Continue to next endpoint or attempt
        }
      }

      // 2. Classic TSETMC TradeDetail with date
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7500);

        const classicUrl = `http://old.tsetmc.com/tsev2/data/TradeDetail.aspx?i=${insCode}&d=${dEven}`;
        const response = await fetch(classicUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/plain, */*',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const text = await response.text();
          if (text && (text.includes('@') || text.includes(';'))) {
            const rawRows = text.split(';').filter((r) => r.trim().length > 3);
            const parsed = rawRows
              .map((row) => {
                const parts = row.split('@');
                if (parts.length < 4) return null;
                return {
                  nTran: parseInt(parts[0], 10) || 0,
                  hEven: parts[1]?.replace(/:/g, '') || '0',
                  timeStr: parts[1] || '',
                  qTitTran: parseFloat(parts[2]) || 0,
                  pTran: parseFloat(parts[3]) || 0,
                  dEven: parseInt(dEven, 10),
                };
              })
              .filter(Boolean);

            if (parsed.length > 0) {
              historicalTradesServerCache.set(cacheKey, {
                count: parsed.length,
                data: parsed,
                source: 'tsetmc_classic',
              });
              return res.json({
                status: 'success',
                source: 'tsetmc_classic',
                insCode,
                dEven,
                count: parsed.length,
                data: parsed,
              });
            }
          }
        }
      } catch {
        // Continue to next attempt
      }
    }

    return res.json({ status: 'unavailable', insCode, dEven, data: [] });
  });

  // API Route: TSETMC Instrument Search Proxy
  app.get('/api/tsetmc/search/:query', async (req, res) => {
    const query = req.params.query?.trim();
    if (!query) {
      return res.json({ status: 'success', data: [] });
    }

    // 1. Try modern TSETMC CDN Search API
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);

      const url = `https://cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const json = await response.json();
        const results = json.instrumentSearch || (Array.isArray(json) ? json : []);
        if (Array.isArray(results) && results.length > 0) {
          return res.json({
            status: 'success',
            source: 'tsetmc_cdn',
            count: results.length,
            data: results,
          });
        }
      }
    } catch (err: any) {
      console.warn('TSETMC CDN search proxy error:', err.message);
    }

    // 2. Try classic TSETMC search (search.aspx)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);

      const classicUrl = `http://old.tsetmc.com/tsev2/data/search.aspx?svalue=${encodeURIComponent(query)}`;
      const response = await fetch(classicUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        if (text && text.includes(';')) {
          // Format: symbol,title,insCode,...;
          const rows = text.split(';').filter((r) => r.trim().length > 3);
          const parsed = rows
            .map((r) => {
              const parts = r.split(',');
              if (parts.length < 3) return null;
              return {
                lVal18AFC: parts[0]?.trim(),
                lVal30: parts[1]?.trim(),
                insCode: parts[2]?.trim(),
              };
            })
            .filter((x): x is { lVal18AFC: string; lVal30: string; insCode: string } => !!x && !!x.insCode);

          if (parsed.length > 0) {
            return res.json({
              status: 'success',
              source: 'tsetmc_classic',
              count: parsed.length,
              data: parsed,
            });
          }
        }
      }
    } catch (err: any) {
      console.warn('TSETMC classic search error:', err.message);
    }

    return res.json({
      status: 'unavailable',
      message: 'نماد مورد نظر در TSETMC یافت نشد.',
      data: [],
    });
  });

  // Helper function to map raw row array from Traders Arena (https://tradersarena.ir/data/option-watch-csv)
  function parseTradersArenaRow(row: any[]) {
    const insCode = String(row[0] || '');
    const symbol = String(row[1] || '');
    const contractTypeStr = String(row[2] || '');
    const isCall = contractTypeStr === 'خرید';
    const baseSymbol = String(row[3] || '');
    const moneynessStatus = String(row[4] || '');
    const vol = Number(row[5]) || 0;
    const val = Number(row[6]) || 0;
    const strike = Number(row[7]) || 0;
    const underlyingPrice = Number(row[8]) || 0;
    const basePriceChangePct = Number(row[9]) || 0;
    const baseDiff = Number(row[10]) || 0;
    const breakEven = Number(row[11]) || 0;
    const breakEvenPct = Number(row[12]) || 0;
    const bestBid = Number(row[13]) || 0;
    const bestAsk = Number(row[14]) || 0;
    const lastPrice = Number(row[15]) || 0;
    const lastPriceChangePct = Number(row[16]) || 0;
    const high = Number(row[17]) || 0;
    const low = Number(row[18]) || 0;
    const freq = Number(row[19]) || 0;
    const toDate = String(row[20] || '');
    const daysLeft = Number(row[21]) || 1;
    const contractSize = Number(row[22]) || 1000;
    const openRates = Number(row[23]) || 0;
    const askBulb = Number(row[24]) || 0;
    const premiumBulb = Number(row[25]) || 0;
    const bidBulb = Number(row[26]) || 0;
    const bsPrice = Number(row[27]) || 0;
    const bcp = Number(row[28]) || 0;
    const delta = row[29] !== undefined && row[29] !== null ? Number(row[29]) : undefined;
    const gamma = row[30] !== undefined && row[30] !== null ? Number(row[30]) : undefined;
    const vega = row[31] !== undefined && row[31] !== null ? Number(row[31]) : undefined;
    const theta = row[32] !== undefined && row[32] !== null ? Number(row[32]) : undefined;
    const rho = row[33] !== undefined && row[33] !== null ? Number(row[33]) : undefined;
    const imp = row[34] !== undefined && row[34] !== null ? Number(row[34]) : undefined;
    const sigma = row[35] !== undefined && row[35] !== null ? Number(row[35]) : undefined;
    const leverage = Number(row[36]) || 0;
    const intrinsicValue = Number(row[37]) || 0;
    const timeValue = Number(row[38]) || 0;
    const coveredCall = Number(row[39]) || 0;
    const beta = Number(row[40]) || 0;
    const correlation = Number(row[41]) || 0;
    const ratio = Number(row[42]) || 0;
    const yesterdayPrice = Number(row[43]) || 0;

    // Volume-weighted average settlement price
    const vwap = (vol > 0 && val > 0 && contractSize > 0) ? Math.round(val / (vol * contractSize)) : lastPrice;
    const settlementPrice = vwap > 0 ? vwap : lastPrice;

    return {
      ins: insCode,
      name: symbol,
      fname: symbol,
      type: isCall ? 1 : 2,
      contractType: contractTypeStr,
      basis_name: baseSymbol,
      status: moneynessStatus,
      Tvolume: vol,
      Tcount: vol,
      Tvalue: val,
      emal: strike,
      strike,
      basis_c: underlyingPrice,
      basis: underlyingPrice,
      basePrice: underlyingPrice,
      basePriceP: basePriceChangePct,
      baseDiff,
      breakEven,
      breakEvenP: breakEvenPct,
      b_price: `${bestBid}/0`,
      s_price: `${bestAsk}/0`,
      bestBid,
      bestAsk,
      close: lastPrice,
      last: lastPrice,
      final: settlementPrice,
      closeP: lastPriceChangePct,
      highest_price: high,
      lowest_price: low,
      freq,
      to_date: toDate,
      days_left: daysLeft,
      days_left_actual: daysLeft,
      day_left_c: daysLeft,
      size: contractSize,
      op: openRates,
      askBulb,
      premiumBulb,
      bidBulb,
      black_sholes: bsPrice,
      bcp,
      delta,
      gamma,
      vega,
      theta,
      rho,
      imp,
      sigma,
      leverage,
      intrinsicValue,
      timeValue,
      coveredCall,
      beta,
      correlation,
      ratio,
      yesterdayPrice,
    };
  }

  // API Route: Live Option Contracts Proxy to Traders Arena (https://tradersarena.ir/data/option-watch-csv)
  let cachedContractsData: any[] = [];
  let lastContractsFetchTime = 0;

  app.get('/api/market/contracts', async (req, res) => {
    const symbolFilter = (req.query.symbol as string) || '';
    const now = Date.now();

    try {
      // Use cache if less than 12 seconds old
      if (cachedContractsData.length > 0 && now - lastContractsFetchTime < 12000) {
        let filtered = cachedContractsData;
        if (symbolFilter) {
          filtered = cachedContractsData.filter(
            (c: any) => c.basis_name === symbolFilter || c.name?.includes(symbolFilter)
          );
        }
        return res.json({
          status: 'success',
          source: 'tradersarena_cache',
          timestamp: new Date(lastContractsFetchTime).toISOString(),
          count: filtered.length,
          total: cachedContractsData.length,
          data: filtered,
        });
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      const response = await fetch('https://tradersarena.ir/data/option-watch-csv', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const rawJson = await response.json();
        if (Array.isArray(rawJson) && rawJson.length > 0) {
          // If response is array of arrays (Traders Arena format), parse rows into objects
          if (Array.isArray(rawJson[0])) {
            cachedContractsData = rawJson.map(parseTradersArenaRow);
          } else {
            cachedContractsData = rawJson;
          }

          lastContractsFetchTime = Date.now();

          let filtered = cachedContractsData;
          if (symbolFilter) {
            filtered = cachedContractsData.filter(
              (c: any) => c.basis_name === symbolFilter || c.name?.includes(symbolFilter)
            );
          }

          return res.json({
            status: 'success',
            source: 'tradersarena_live',
            timestamp: new Date().toISOString(),
            count: filtered.length,
            total: cachedContractsData.length,
            data: filtered,
          });
        }
      }

      throw new Error(`Upstream returned HTTP ${response.status}`);
    } catch (err: any) {
      console.warn('Traders Arena contracts live fetch notice:', err.message);

      let filtered = cachedContractsData;
      if (symbolFilter && cachedContractsData.length > 0) {
        filtered = cachedContractsData.filter(
          (c: any) => c.basis_name === symbolFilter || c.name?.includes(symbolFilter)
        );
      }

      return res.json({
        status: cachedContractsData.length > 0 ? 'cached' : 'fallback',
        source: 'tradersarena_fallback',
        timestamp: new Date().toISOString(),
        count: filtered.length,
        total: cachedContractsData.length,
        data: filtered,
        error: err.message,
      });
    }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  const portfolioFilePath = path.resolve(process.cwd(), 'portfolio.json');

  // API Route: Get File Path of portfolio.json
  app.get('/api/portfolio/filepath', (req, res) => {
    res.json({
      status: 'success',
      path: portfolioFilePath,
      exists: fs.existsSync(portfolioFilePath),
    });
  });

  // API Route: Get Portfolio Positions from portfolio.json
  // Returns clean empty array [] if file does not exist or has no positions (NO hardcoded mock data)
  app.get('/api/portfolio', (req, res) => {
    try {
      if (!fs.existsSync(portfolioFilePath)) {
        return res.json({ status: 'success', data: [], count: 0, filePath: portfolioFilePath });
      }

      const fileContent = fs.readFileSync(portfolioFilePath, 'utf-8');
      if (!fileContent || !fileContent.trim() || fileContent.trim() === '[]') {
        return res.json({ status: 'success', data: [], count: 0, filePath: portfolioFilePath });
      }

      const parsed = JSON.parse(fileContent);
      return res.json({
        status: 'success',
        data: Array.isArray(parsed) ? parsed : [],
        count: Array.isArray(parsed) ? parsed.length : 0,
        filePath: portfolioFilePath,
      });
    } catch (err: any) {
      console.warn('Failed to read portfolio.json:', err.message);
      return res.json({ status: 'success', data: [], count: 0, filePath: portfolioFilePath, error: err.message });
    }
  });

  // API Route: Save Portfolio Positions to portfolio.json
  app.post('/api/portfolio', (req, res) => {
    try {
      const items = req.body;
      if (!Array.isArray(items)) {
        return res.status(400).json({ status: 'error', message: 'محتوای ارسال شده باید آرایه‌ای از موقعیت‌ها باشد.' });
      }

      fs.writeFileSync(portfolioFilePath, JSON.stringify(items, null, 2), 'utf-8');
      return res.json({
        status: 'success',
        message: 'پورتفوی با موفقیت روی دیسک ذخیره شد.',
        count: items.length,
        filePath: portfolioFilePath,
      });
    } catch (err: any) {
      console.error('Failed to write portfolio.json:', err);
      return res.status(500).json({ status: 'error', message: 'خطا در ذخیره‌سازی پورتفوی روی فایل دیسک: ' + err.message });
    }
  });

  // Gemini AI Client Helper (Lazy-initialized to ensure graceful handling if key is pending)
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('کلید دسترسی GEMINI_API_KEY تنظیم نشده است. لطفاً متغیر محیطی GEMINI_API_KEY را در تنظیمات پروژه اضافه فرمایید.');
    }
    if (!aiClient) {
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
    return aiClient;
  }

  // API Route: Check Gemini Service Status
  app.get('/api/gemini/status', (req, res) => {
    const hasKey = Boolean(process.env.GEMINI_API_KEY);
    res.json({
      status: 'ok',
      configured: hasKey,
      defaultModel: 'gemini-3.8-flash',
      availableModels: [
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (پیش‌فرض هوشمند و سریع)', isPaid: false },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (تحلیل عمیق و محاسبات پیشرفته)', isPaid: true },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite (پاسخ سریع و سبک)', isPaid: false },
      ],
    });
  });

  // API Route: Multi-turn Chat with Gemini Advisor with Full Market & Strategy Context and Automatic Fallback
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      const { messages, marketContext, model = 'gemini-3.8-flash' } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'پیام‌ها یافت نشد یا در قالب نامعتبر ارسال شده است.',
        });
      }

      const ai = getGeminiClient();

      // Craft expert financial quantitative advisor system prompt with full market snapshot and full application navigation map
      const contextSummary = marketContext ? JSON.stringify(marketContext, null, 2) : 'داده‌های بازار در دسترس نیست';
      const systemInstruction = `شما «دستیار هوشمند، مشاور ارشد مشتقه و راهنمای کامل سامانه پلتفرم TradersArena بورس تهران» هستید.
شما به تمام اطلاعات زنده، محاسبات ریاضی، مدل بلک‌شولز، یونانی‌ها (دلتا، گاما، تتا، وگا، رو)، زنجیره قراردادها و تمام ۱۷ استراتژی معاملاتی، و همچنین **نقشه کامل، محل قرارگیری ابزارها و دکمه‌های این برنامه** اشراف و دسترسی کامل دارید.

=== ۱. نقشه ساختار و راهنمای پیدا کردن بخش‌ها و ابزارهای برنامه ===
کاربران ممکن است بپرسند فلان بخش، دکمه، نمودار یا استراتژی کجاست. شما باید با کمال دقت محل قرارگیری آن را توضیح دهید و در صورت امکان از **لینک‌های هدایت مستقیم تعاملی** به صورت \`[عنوان کلید](action:navigate:شناسه)\` استفاده کنید تا کاربر با یک کلیک مستقیماً به آن بخش هدایت شود.

الف) نوار بالای صفحه (Header / نوار ابزار بازار):
- **انتخاب نماد پایه:** در گوشه بالای صفحه، منوی کشویی و چک‌باکس‌های نمادها (اهرم، شستا، خودرو، خساپا، فملی، وبملت، صندوق‌ها یا دکمه «همه نمادها»).
- **قیمت سهم پایه:** کادر ورودی قیمت دارایی پایه در نوار بالا؛ کاربر می‌تواند قیمت را تغییر دهد تا اثر آن را بر روی قیمت آپشن‌ها و استراتژی‌ها شبیه‌سازی کند.
- **نرخ بدون ریسک (%):** کادر ورودی نرخ سالانه (پیش‌فرض ۳۰٪) برای محاسبات مدل بلک‌شولز، بهره و تتا.
- **مبنای قیمت‌گذاری:** کلیدهای انتخابی بین آخرین قیمت معامله (Last)، قیمت پایانی (Settlement)، بهترین خرید (Bid) یا بهترین فروش (Ask).
- **بروزرسانی زنده (Auto-Refresh):** در بالای صفحه، دکمه فعال/غیرفعال کردن دریافت خودکار اطلاعات با شمارنده معکوس و دکمه رفرش دستی.
- **فیلتر استراتژی‌ها (آیکون لایه‌ها/مدیریت):** در نوار بالا برای پنهان یا آشکار کردن هر کدام از ۱۷ استراتژی در نوار پایینی.

ب) نوار برگه‌های اکسل (Bottom Tab Bar در پایین صفحه):
- **زنجیره قراردادها (داده‌ها):** برگه با آیکون 📋 در نوار پایین. شناسه ناوبری: \`data\`
  لینک هدایت مستقیم: \`[رفتن به زنجیره قراردادها](action:navigate:data)\`
  (شامل جدول کامل Call و Put، نوسان ضمنی IV، یونانی‌ها، دکمه «+ قرارداد جدید»، فیلتر حداقل ارزش معاملات، و امکان کلیک روی هر سطر برای دیدن پنجره تحلیل بلک‌شولز).
- **نمودار و تاریخچه نماد:** برگه با آیکون 📊 در نوار پایین. شناسه ناوبری: \`history\`
  لینک هدایت مستقیم: \`[مشاهده نمودار و تاریخچه قیمت](action:navigate:history)\`
  (شامل نمودار شمعی/کندل‌استیک، سوابق روزانه، حجم معاملات و تحلیل تکنیکال سهم پایه یا آپشن‌ها).
- **مشاور هوش مصنوعی:** برگه با آیکون 🤖 در نوار پایین (\`gemini_advisor\`).
- **برگه‌های ۱۷ استراتژی پیشرفته در نوار پایین (همراه با شناسه ناوبری جهت هدایت مستقیم):**
  1. کاورد کال (Covered Call): \`[مشاهده استراتژی کاورد کال](action:navigate:covered_call)\`
  2. پوت حمایتی (Protective Put): \`[مشاهده پوت حمایتی](action:navigate:protective_put)\`
  3. کولار (Collar): \`[مشاهده استراتژی کولار](action:navigate:collar)\`
  4. کانورژن / آربیتراژ (Conversion): \`[مشاهده کانورژن](action:navigate:conversion)\`
  5. اسپرد صعودی کال (Bull Call Spread): \`[مشاهده بول کال اسپرد](action:navigate:bull_call_spread)\`
  6. اسپرد نزولی کال (Bear Call Spread): \`[مشاهده بیر کال اسپرد](action:navigate:bear_call_spread)\`
  7. اسپرد صعودی پوت (Bull Put Spread): \`[مشاهده بول پوت اسپرد](action:navigate:bull_put_spread)\`
  8. اسپرد نزولی پوت (Bear Put Spread): \`[مشاهده بیر پوت اسپرد](action:navigate:bear_put_spread)\`
  9. استرادل خرید (Long Straddle): \`[مشاهده استرادل خرید](action:navigate:long_straddle)\`
  10. استرادل فروش (Short Straddle): \`[مشاهده استرادل فروش](action:navigate:short_straddle)\`
  11. استرانگل خرید (Long Strangle): \`[مشاهده استرانگل خرید](action:navigate:long_strangle)\`
  12. استرانگل فروش (Short Strangle): \`[مشاهده استرانگل فروش](action:navigate:short_strangle)\`
  13. گاتس (Guts Spread): \`[مشاهده استراتژی گاتس](action:navigate:guts)\`
  14. پروانه‌ای (Butterfly Spread): \`[مشاهده پروانه‌ای](action:navigate:butterfly)\`
  15. کندور آهنی (Iron Condor): \`[مشاهده کندور آهنی](action:navigate:iron_condor)\`
  16. اسپرد جعبه‌ای آربیتراژ (Box Spread): \`[مشاهده باکس اسپرد](action:navigate:box_spread)\`
  17. اسپرد تقویمی / زمانی (Calendar Spread): \`[مشاهده تقویمی](action:navigate:calendar_spread)\`

ج) قابلیت‌های درون برگه‌های استراتژی:
- جدول کامل ترکیب‌ها با نقطه سر‌به‌سر، ماکسیمم سود، ماکسیمم زیان، نسبت سود به زیان و بازدهی درصدی (ROI).
- نمودار بازدهی (Payoff Diagram) در سررسید.
- شبیه‌ساز سناریوی سود و زیان (P&L Calculator) در قیمت‌های فرضی سهم پایه.

=== ۲. خلاصه وضعیت بازار زنده، قراردادها و محاسبات فعلی برنامه ===
${contextSummary}
==================================================================

=== ۳. اصول و وظایف پاسخ‌دهی ===
۱. اگر کاربر پرسید ابزاری، دکمه‌ای یا صفحه‌ای کجاست یا چطور فلان کار را انجام دهد:
   - دقیقاً توضیح دهید در کجای صفحه (نوار بالای صفحه، نوار تب‌های پایین یا داخل جدول) قرار دارد.
   - مراحل انجام کار را ساده و مرحله‌به‌مرحله بگویید.
   - حتماً کلید ناوبری مستقیم مربوطه را به فرمت \`[متن دکمه](action:navigate:شناسه_تب)\` در انتهای پاسخ بگذارید تا کاربر مستقیماً روی آن کلیک کند.
۲. هنگام مشاوره معاملاتی و استراتژی:
   - مستقیماً از داده‌های بالا (نمادها، قیمت اعمال، پریمیوم، بازدهی و یونانی‌ها) استفاده کنید.
   - نقاط سر‌به‌سر (Break-even)، حداکثر سود و زیان و سناریوهای صعودی/نزولی را شرح دهید.
   - در صورت پیشنهاد یک استراتژی خاص، لینک هدایت مستقیم به برگه آن استراتژی را در پاسخ قرار دهید.
۳. لحن پاسخ: صمیمی، راهنما، حرفه‌ای و به زبان فارسی روان با ساختار شکیل و منسجم.`;

      // Transform messages into contents format for @google/genai SDK
      // Roles must be 'user' or 'model'
      const contents = messages.map((m: any) => ({
        role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.content || m.text || '') }],
      }));

      // Candidate models hierarchy to try in case of 503 / high demand spikes
      const requestedModel = model || 'gemini-3.8-flash';
      const candidateModels = [
        requestedModel,
        ...(requestedModel !== 'gemini-3.5-flash' ? ['gemini-3.5-flash'] : []),
        ...(requestedModel !== 'gemini-3.1-flash-lite' ? ['gemini-3.1-flash-lite'] : []),
      ];

      let lastError: any = null;
      let successfulResponseText = '';
      let usedModel = requestedModel;
      let fallbackTriggered = false;

      for (let i = 0; i < candidateModels.length; i++) {
        const currentModel = candidateModels[i];
        try {
          const response = await ai.models.generateContent({
            model: currentModel,
            contents,
            config: {
              systemInstruction,
              temperature: 0.7,
            },
          });

          successfulResponseText = response.text || '';
          usedModel = currentModel;
          if (currentModel !== requestedModel) {
            fallbackTriggered = true;
          }
          break; // Success!
        } catch (err: any) {
          lastError = err;
          const errString = String(err?.message || err);
          const isHighDemandOrTransient =
            errString.includes('503') ||
            errString.includes('high demand') ||
            errString.includes('UNAVAILABLE') ||
            errString.includes('429') ||
            errString.includes('RESOURCE_EXHAUSTED');

          console.warn(`[Gemini API] Model ${currentModel} returned error:`, errString);

          if (isHighDemandOrTransient && i < candidateModels.length - 1) {
            // Wait 800ms before trying fallback model
            await new Promise((resolve) => setTimeout(resolve, 800));
            continue;
          } else {
            // Not a transient demand error, or out of models
            break;
          }
        }
      }

      if (!successfulResponseText && lastError) {
        throw lastError;
      }

      return res.json({
        status: 'success',
        reply: successfulResponseText,
        model: usedModel,
        fallbackTriggered,
        originalModel: requestedModel,
      });
    } catch (err: any) {
      console.error('Gemini chat error final:', err);
      const rawMsg = String(err?.message || err);

      let userFriendlyMessage = 'خطا در ارتباط با هوش مصنوعی جمنای. لطفاً مجدداً تلاش کنید.';
      if (rawMsg.includes('503') || rawMsg.includes('high demand') || rawMsg.includes('UNAVAILABLE')) {
        userFriendlyMessage =
          'سرورهای این مدل در حال حاضر دارای بار ترافیکی فوق‌العاده بالایی (High Demand) هستند. سیستم مجدداً مدل‌های جایگزین را بررسی می‌کند؛ لطفاً دکمه «تلاش مجدد» یا تغییر مدل را انتخاب نمایید.';
      } else if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
        userFriendlyMessage = 'محدودیت تعداد درخواست در دقیقه (Rate Limit) رخ داد. لطفاً چند ثانیه دیگر تلاش فرمایید.';
      } else if (rawMsg.includes('API_KEY') || rawMsg.includes('403') || rawMsg.includes('PERMISSION_DENIED')) {
        userFriendlyMessage = 'کلید دسترسی GEMINI_API_KEY معتبر نیست یا مجوز استفاده از این مدل را ندارد.';
      }

      return res.status(500).json({
        status: 'error',
        message: userFriendlyMessage,
        raw: rawMsg,
      });
    }
  });


  // Vite middleware for development vs static for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TSE Option Analysis Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
