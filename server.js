// my-proxy-final/server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nlp = require('compromise'); // ✨ FIX: nlp 라이브러리 선언 추가
const path = require('path'); // ✨ FIX: path 모듈 추가

const app = express();
const PORT = process.env.PORT || 10000;

// ✨ FIX: kTickerInfo를 Redis에서 로드하기 위한 전역 변수
let kTickerInfo = {};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // ✨ FIX: 'public' 폴더를 정적 파일 경로로 설정
app.use(express.urlencoded({ extended: true })); // For form submissions

// ✨ FIX: 서버 시작 시 Redis에서 주식 정보를 로드하는 함수
async function loadTickerInfoFromRedis() {
  console.log('Loading ticker info from Redis...');
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  // ✨ FIX: 서버 시작 시 발생하는 오류를 처리하여 안정성 확보
  try {
    kTickerInfo = await redis.hgetall('stock-info') || {};
    console.log(`${Object.keys(kTickerInfo).length} tickers loaded successfully.`);
  } catch (error) {
    console.error('Failed to load ticker info from Redis on startup:', error);
    // Redis에서 데이터를 로드하지 못해도 서버는 계속 실행되도록 합니다.
  }
}
// --- API 호출 및 계산 헬퍼 함수 ---
async function fetchStockDataFromYahoo(ticker) {
  if (!ticker) return null;

  // 1. SSRF 방지를 위해 ticker 포맷 검증 (알파벳 대문자, 숫자, 마침표(.)만 허용)
  const validTickerRegex = /^[A-Z0-9.]+$/;
  if (!validTickerRegex.test(ticker)) {
    console.warn('Invalid ticker format detected: %s', ticker);
    return null;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1mo&interval=1d`;
    const response = await fetch(url);
    if (!response.ok) {
      // 2. 로그 출력 방식 수정
      console.warn('Failed to fetch data for ticker: %s, Status: %s', ticker, response.status);
      return null;
    }
    const data = await response.json();
    return data?.chart?.result?.[0];
  } catch (error) {
    // 2. 로그 출력 방식 수정
    console.error('Error fetching data for ticker: %s', ticker, error);
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
      return res.status(404).json({ error: 'Analyzed data not found. Please run the analysis script.' });
    }
    
    return res.status(200).json(cachedData);
    
  } catch (error) {
    console.error('Themes API Error:', error);
    return res.status(500).json({ error: 'Failed to fetch recommendations from cache.' });
  }
});

app.get('/dashboard', (req, res) => {
    // ✨ FIX: 'public' 폴더의 dashboard.html 파일을 전송하도록 수정
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
    
    const queryResult = await index.query({ 
        topK: 100, 
        vector: queryVector, 
        includeMetadata: true,
        filter: { "theme": { "$eq": theme } } // ✨ FIX: Pinecone 쿼리에 테마 필터 추가
    });
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

// Admin API Endpoints
app.get('/api/stats', async (req, res) => {
    try {
        const pinecone = new Pinecone();
        const index = pinecone.index('gcp-starter-gemini');
        const pineconeStats = await index.describeIndexStats();

        const redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        const newsDateRange = await redis.get('news_date_range') || { oldest: 'N/A', newest: 'N/A' };
        const redisStockCount = await redis.hlen('stock-info');

        res.json({
            pineconeVectors: pineconeStats.totalVectorCount || 0,
            newsDateRange,
            redisStockCount,
        });
    } catch (error) {
        console.error('Stats API Error:', error);
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

app.get('/api/stocks', async (req, res) => {
    try {
        const redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        const stocks = await redis.hgetall('stock-info');
        res.json(stocks || {});
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stocks from Redis.' });
    }
});

app.post('/api/stocks', async (req, res) => {
    const { ticker, name, style, keywords, password } = req.body;
    if (!ticker || !name || !style) {
        return res.status(400).json({ error: 'Ticker, name, and style are required.' });
    }
    try {
        const redis = new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL,
            token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        const stockInfo = { name, style, keywords: keywords || [] };
        await redis.hset('stock-info', { [ticker]: JSON.stringify(stockInfo) });
        await loadTickerInfoFromRedis(); // Refresh in-memory cache
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save stock to Redis.' });
    }
});

app.delete('/api/stocks', async (req, res) => {
    const { ticker, password } = req.body;
    if (!ticker) {
        return res.status(400).json({ error: 'Ticker is required.' });
    }
    try {
        const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
        await redis.hdel('stock-info', ticker);
        await loadTickerInfoFromRedis(); // Refresh in-memory cache
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete stock from Redis.' });
    }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  // ✨ FIX: 서버가 시작되면 즉시 Redis에서 데이터를 로드
  loadTickerInfoFromRedis();
});