// my-proxy-final/server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 10000; // Render는 10000 포트를 사용합니다

app.use(cors());
app.use(express.json());

// --- 상수 정의 ---
const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'], style: 'leading' }, 'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'], style: 'leading' }, 'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'], style: 'growth' }, 'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'], style: 'growth' }, 'AMD': { name: 'Advanced Micro Devices', keywords: ['amd', 'advanced micro devices'], style: 'growth' }, 'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'meta platforms', 'facebook'], style: 'leading' }, 'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'apple inc'], style: 'leading' }, 'RBLX': { name: 'Roblox Corporation', keywords: ['roblox'], style: 'growth' }, 'U': { name: 'Unity Software Inc.', keywords: ['unity', 'unity software'], style: 'growth' }, 'SNAP': { name: 'Snap Inc.', keywords: ['snap inc', 'snapchat'], style: 'growth' }, 'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla'], style: 'leading' }, 'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian', 'r1t', 'electric truck'], style: 'growth' }, 'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid', 'air', 'ev'], style: 'growth' }, 'GM': { name: 'General Motors Company', keywords: ['gm', 'general motors'], style: 'leading' }, 'F': { name: 'Ford Motor Company', keywords: ['ford'], style: 'leading' }, 'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'amazon.com'], style: 'leading' }, 'GOOGL': { name: 'Alphabet Inc.', keywords: ['alphabet', 'google'], style: 'leading' }, 'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake', 'data cloud'], style: 'growth' }, 'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike', 'cybersecurity'], style: 'growth' }, 'MRNA': { name: 'Moderna, Inc.', keywords: ['moderna'], style: 'growth' }, 'PFE': { name: 'Pfizer Inc.', keywords: ['pfizer'], style: 'leading' }, 'DIS': { name: 'The Walt Disney Company', keywords: ['disney'], style: 'leading' }, 'NFLX': { name: 'Netflix, Inc.', keywords: ['netflix'], style: 'leading' }
};

// --- API 호출 및 계산 헬퍼 함수 ---
async function fetchStockDataFromYahoo(ticker) {
  if (!ticker) return null;
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

// --- API 라우트 ---

// '/api/themes' 경로: Redis에서 미리 분석된 종목 목록을 반환
app.get('/api/themes', async (req, res) => {
  console.log("Received request for /api/themes");
  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const cachedData = await redis.get('latest_recommendations');
    if (!cachedData) {
      console.error("No cached data found in Redis for 'latest_recommendations'");
      return res.status(404).json({ error: 'Analyzed data not found. Please run the analysis script.' });
    }
    
    // ✨ 여기가 수정된 부분입니다.
    // Redis에서 가져온 데이터가 문자열이므로, 객체로 다시 파싱해서 보내줍니다.
    return res.status(200).json(JSON.parse(cachedData));
    
  } catch (error) {
    console.error('Themes API Error:', error);
    return res.status(500).json({ error: 'Failed to fetch recommendations from cache.' });
  }
});

// '/api/details' 경로: 특정 종목의 상세 정보를 실시간으로 조회
app.get('/api/details', async (req, res) => {
  console.log(`Received request for /api/details with ticker: ${req.query.ticker}`);
  try {
    const { ticker, theme } = req.query;
    if (!ticker) { return res.status(400).json({ error: 'Ticker is required' }); }
    
    const stockData = await fetchStockDataFromYahoo(ticker);
    if (!stockData) { return res.status(404).json({ error: 'Stock data not found' }); }

    const pinecone = new Pinecone();
    const index = pinecone.index('gcp-starter-gemini');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    
    const companyNameForEmbedding = kTickerInfo[ticker]?.name || ticker;
    const embeddingResult = await embeddingModel.embedContent(companyNameForEmbedding);
    const queryVector = embeddingResult.embedding.values;
    
    const queryResult = await index.query({ topK: 100, vector: queryVector, includeMetadata: true });
    const allFoundArticles = queryResult.matches.map(match => match.metadata);

    const { timestamps, indicators } = stockData;
    const quotes = indicators?.quote?.[0]?.close?.filter(q => q != null) || [];
    const smaShort = calculateSMA(quotes, 5);
    const smaLong = calculateSMA(quotes, 20);
    const rsi14 = calculateRSI(quotes, 14);
    
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
    const topKeywords = nlp(titleText).nouns().out('freq').filter(item => item.normal.length > 2 && isNaN(item.normal)).slice(0, 10).map(item => item.normal);
        
    const finalData = {
      ticker,
      companyName: kTickerInfo[ticker]?.name || ticker,
      latestPrice: quotes.length > 0 ? quotes[quotes.length-1] : 0,
      chartData: quotes.map((q, i) => ({ x: i, y: q })),
      timestamps: timestamps || [],
      smaShortData: smaShort.map((s, i) => s === null ? null : ({ x: i, y: s })).filter(Boolean),
      smaLongData: smaLong.map((s, i) => s === null ? null : ({ x: i, y: s })).filter(Boolean),
      rsi: rsi14,
      trendingTheme: theme,
      relevantArticles: relevantArticles.slice(0, 5),
      dailyNewsStats,
      topKeywords,
    };
    
    return res.status(200).json(finalData);

  } catch (error) {
    console.error('Details API Error:', error);
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});