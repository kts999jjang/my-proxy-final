// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- 상수 정의 ---
const kInvestmentThemes = {
  '인공지능(AI)': { query: '"artificial intelligence" OR "semiconductor" OR "machine learning" OR "NVIDIA"', },
  '메타버스 & VR': { query: '"metaverse" OR "virtual reality" OR "augmented reality" OR "Roblox" OR "Unity"', },
  '전기차 & 자율주행': { query: '"electric vehicle" OR "self-driving" OR "autonomous car" OR "Tesla" OR "Rivian"', },
  '클라우드 컴퓨팅': { query: '"cloud computing" OR "data center" OR "SaaS" OR "Amazon AWS" OR "Microsoft Azure"', },
  '바이오/헬스케어': { query: '"biotechnology" OR "healthcare" OR "pharmaceutical" OR "clinical trial"', },
  '엔터테인먼트/미디어': { query: '"entertainment" OR "streaming" OR "media" OR "Disney" OR "Netflix"', },
  '친환경/에너지': { query: '"renewable energy" OR "solar power" OR "wind power" OR "clean energy"', },
};

const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'], style: 'leading' },
  'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'], style: 'leading' },
  'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'], style: 'growth' },
  'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'], style: 'growth' },
  'AMD': { name: 'Advanced Micro Devices', keywords: ['amd', 'advanced micro devices'], style: 'growth' },
  'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'meta platforms', 'facebook'], style: 'leading' },
  'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'apple inc'], style: 'leading' },
  'RBLX': { name: 'Roblox Corporation', keywords: ['roblox'], style: 'growth' },
  'U': { name: 'Unity Software Inc.', keywords: ['unity', 'unity software'], style: 'growth' },
  'SNAP': { name: 'Snap Inc.', keywords: ['snap inc', 'snapchat'], style: 'growth' },
  'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla'], style: 'leading' },
  'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian', 'r1t', 'electric truck'], style: 'growth' },
  'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid', 'air', 'ev'], style: 'growth' },
  'GM': { name: 'General Motors Company', keywords: ['gm', 'general motors'], style: 'leading' },
  'F': { name: 'Ford Motor Company', keywords: ['ford'], style: 'leading' },
  'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'amazon.com'], style: 'leading' },
  'GOOGL': { name: 'Alphabet Inc.', keywords: ['alphabet', 'google'], style: 'leading' },
  'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake', 'data cloud'], style: 'growth' },
  'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike', 'cybersecurity'], style: 'growth' },
  'MRNA': { name: 'Moderna, Inc.', keywords: ['moderna'], style: 'growth' },
  'PFE': { name: 'Pfizer Inc.', keywords: ['pfizer'], style: 'leading' },
  'DIS': { name: 'The Walt Disney Company', keywords: ['disney'], style: 'leading' },
  'NFLX': { name: 'Netflix, Inc.', keywords: ['netflix'], style: 'leading' }
};

// --- API 호출 및 계산 함수들 ---
async function fetchStockDataFromYahoo(tickers) {
  if (!tickers || tickers.length === 0) return [];
  const requests = tickers.map(async (ticker) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1mo&interval=1d`;
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`Failed to fetch data for ticker: ${ticker}, Status: ${response.status}`);
        return null;
      }
      const data = await response.json();
      return data?.chart?.result?.[0];
    } catch (error) {
      console.error(`Error fetching data for ticker: ${ticker}`, error);
      return null;
    }
  });
  const results = await Promise.all(requests);
  return results.filter(Boolean);
}

async function getTickerForCompanyName(companyName) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  const cleanedName = companyName.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
  const cachedTicker = await redis.get(cleanedName);
  if (cachedTicker) { return cachedTicker; }
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not set.');
  const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${cleanedName}&apikey=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  const bestMatch = data?.bestMatches?.[0];
  if (bestMatch && parseFloat(bestMatch['9. matchScore']) > 0.7) {
    const ticker = bestMatch['1. symbol'];
    await redis.set(cleanedName, ticker, { ex: 60 * 60 * 24 * 7 });
    return ticker;
  }
  return null;
}

function calculateSMA(data, period) {
  if (!data || data.length < period) return [];
  const result = [];
  for (let i = 0; i < period - 1; i++) { result.push(null); }
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((acc, val) => acc + val, 0);
    result.push(sum / period);
  }
  return result;
}

function calculateRSI(data, period = 14) {
  if (!data || data.length <= period) return null;
  let gains = [];
  let losses = [];
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) { gains.push(diff); losses.push(0); }
    else { gains.push(0); losses.push(-diff); }
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// --- 메인 핸들러 ---
module.exports = async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') { return response.status(200).end(); }

  try {
    const { 
      analysisDays = '14', 
      themes = '인공지능(AI)' 
    } = request.query;
    
    const selectedThemeNames = themes.split(',');
    if (selectedThemeNames.length === 0 || selectedThemeNames[0] === '') {
        return response.status(200).json({ results: {} });
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - parseInt(analysisDays, 10));
    
    const pinecone = new Pinecone(); 
    const index = pinecone.index('gcp-starter-gemini');

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const analysisPromises = selectedThemeNames.map(async (themeName) => {
      const themeData = kInvestmentThemes[themeName];
      if (!themeData) return null;

      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `summary:${themeName}:${today}`;
      let themeSentence = await redis.get(cacheKey);
      
      let allFoundArticles = [];
      if (!themeSentence) {
        const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(themeData.query)}&topic=business,technology&lang=en&max=50&from=${fromDate.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
        const latestNewsResponse = await fetch(gnewsUrl);
        const latestNews = await latestNewsResponse.json();
        if (!latestNews.articles || latestNews.articles.length === 0) return null;
        
        const headlines = latestNews.articles.map(a => a.title).join('\n');
        const prompt = `Summarize the key trend within the '${themeName}' theme from these headlines in one objective sentence:\n\n${headlines}`;
        const result = await geminiModel.generateContent(prompt);
        themeSentence = result.response.text();
        await redis.set(cacheKey, themeSentence, { ex: 43200 });
      }

      const embeddingResult = await embeddingModel.embedContent(themeSentence);
      const queryVector = embeddingResult.embedding.values;
      
      const queryResult = await index.query({ 
        topK: 200, vector: queryVector, includeMetadata: true,
        filter: { "publishedAt": { "$gte": fromDate.getTime() / 1000 } }
      });
      allFoundArticles = queryResult.matches.map(match => match.metadata);
      if (allFoundArticles.length === 0) return null;
      
      const organizationCounts = {};
      const blacklist = new Set(['ai', 'corp', 'inc', 'ltd', 'llc', 'co', 'group']);
      allFoundArticles.forEach(article => {
        const doc = nlp(article.title);
        doc.organizations().out('array').forEach(org => {
          const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
          if (!blacklist.has(orgName) && orgName.length > 1) {
            organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
          }
        });
      });

      const themeTickerScores = {};
      for (const orgName of Object.keys(organizationCounts)) {
        const ticker = await getTickerForCompanyName(orgName);
        if (ticker) {
          themeTickerScores[ticker] = (themeTickerScores[ticker] || 0) + organizationCounts[orgName];
        }
      }
      if (Object.keys(themeTickerScores).length === 0) return null;
      
      const leadingStocks = Object.entries(themeTickerScores).sort(([,a],[,b]) => b-a).filter(([t]) => kTickerInfo[t]?.style === 'leading').slice(0, 2).map(([t])=>t);
      const growthStocks = Object.entries(themeTickerScores).sort(([,a],[,b]) => b-a).filter(([t]) => kTickerInfo[t]?.style === 'growth').slice(0, 2).map(([t])=>t);
      const topTickersForTheme = [...new Set([...leadingStocks, ...growthStocks])];
      if (topTickersForTheme.length === 0) return null;

      const stockDataResults = await fetchStockDataFromYahoo(topTickersForTheme);
      if (stockDataResults.length === 0) return null;
      
      const recommendations = stockDataResults.map(stockData => {
        if (!stockData || !stockData.meta) return null;
        const ticker = stockData.meta.symbol;
        const timestamps = stockData.timestamp || [];
        const quotes = stockData.indicators?.quote?.[0]?.close?.filter(q => q != null) || [];
        const smaShort = calculateSMA(quotes, 5);
        const smaLong = calculateSMA(quotes, 20);
        const rsi14 = calculateRSI(quotes, 14);
        const chartData = quotes.map((q, i) => ({ x: i, y: q }));
        const smaShortData = smaShort.map((s, i) => s === null ? null : ({ x: i, y: s })).filter(Boolean);
        const smaLongData = smaLong.map((s, i) => s === null ? null : ({ x: i, y: s })).filter(Boolean);
        const companyName = kTickerInfo[ticker]?.name || stockData.meta.symbol;
        const searchKeywords = kTickerInfo[ticker]?.keywords || [ticker.toLowerCase()];
        const relevantArticles = allFoundArticles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw)));
        const dailyNewsStats = {};
        relevantArticles.forEach(article => {
            if (article.publishedAt) {
                const date = new Date(article.publishedAt * 1000).toISOString().split('T')[0];
                dailyNewsStats[date] = (dailyNewsStats[date] || 0) + 1;
            }
        });
        const titleText = relevantArticles.map(a => a.title).join(' ');
        const doc = nlp(titleText);
        const topKeywords = doc.nouns().out('freq')
                               .filter(item => item.normal.length > 2 && isNaN(item.normal))
                               .slice(0, 10)
                               .map(item => item.normal);
        
        return {
          ticker, companyName,
          latestPrice: quotes.length > 0 ? quotes[quotes.length-1] : 0,
          chartData, timestamps, smaShortData, smaLongData, rsi: rsi14,
          trendingTheme: themeName,
          relevantArticles: relevantArticles.slice(0, 5),
          dailyNewsStats, topKeywords,
        };
      }).filter(Boolean);

      if (recommendations.length > 0) {
        return {
          themeName: themeName,
          data: {
            styleInfo: {
              leading: recommendations.filter(r => kTickerInfo[r.ticker]?.style === 'leading'),
              growth: recommendations.filter(r => kTickerInfo[r.ticker]?.style === 'growth'),
            }
          }
        };
      }
      return null;
    });

    const analysisResults = (await Promise.all(analysisPromises)).filter(Boolean);
    const finalResults = {};
    for (const result of analysisResults) {
        if (result) {
            finalResults[result.themeName] = result.data;
        }
    }

    response.status(200).json({ results: finalResults });

  } catch (error) {
    console.error('Server Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
};