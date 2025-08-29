// my-proxy-final/api/details.js

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- 상수 정의 ---
const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'], style: 'leading' }, 'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'], style: 'leading' }, 'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'], style: 'growth' }, 'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'], style: 'growth' }, 'AMD': { name: 'Advanced Micro Devices', keywords: ['amd', 'advanced micro devices'], style: 'growth' }, 'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'meta platforms', 'facebook'], style: 'leading' }, 'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'apple inc'], style: 'leading' }, 'RBLX': { name: 'Roblox Corporation', keywords: ['roblox'], style: 'growth' }, 'U': { name: 'Unity Software Inc.', keywords: ['unity', 'unity software'], style: 'growth' }, 'SNAP': { name: 'Snap Inc.', keywords: ['snap inc', 'snapchat'], style: 'growth' }, 'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla'], style: 'leading' }, 'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian', 'r1t', 'electric truck'], style: 'growth' }, 'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid', 'air', 'ev'], style: 'growth' }, 'GM': { name: 'General Motors Company', keywords: ['gm', 'general motors'], style: 'leading' }, 'F': { name: 'Ford Motor Company', keywords: ['ford'], style: 'leading' }, 'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'amazon.com'], style: 'leading' }, 'GOOGL': { name: 'Alphabet Inc.', keywords: ['alphabet', 'google'], style: 'leading' }, 'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake', 'data cloud'], style: 'growth' }, 'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike', 'cybersecurity'], style: 'growth' }, 'MRNA': { name: 'Moderna, Inc.', keywords: ['moderna'], style: 'growth' }, 'PFE': { name: 'Pfizer Inc.', keywords: ['pfizer'], style: 'leading' }, 'DIS': { name: 'The Walt Disney Company', keywords: ['disney'], style: 'leading' }, 'NFLX': { name: 'Netflix, Inc.', keywords: ['netflix'], style: 'leading' }
};

// --- API 호출 및 계산 함수들 ---
async function fetchStockDataFromYahoo(ticker) { /* ... fetchStockDataFromYahoo와 동일, 단일 티커용 */ }
function calculateSMA(data, period) { /* ... */ }
function calculateRSI(data, period = 14) { /* ... */ }


module.exports = async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (request.method === 'OPTIONS') { return response.status(200).end(); }

  try {
    const { ticker, theme } = request.query;
    if (!ticker) { return response.status(400).json({ error: 'Ticker is required' }); }
    
    // 1. Yahoo Finance에서 주가 데이터 가져오기
    const stockData = await fetchStockDataFromYahoo(ticker);
    if (!stockData) { return response.status(404).json({ error: 'Stock data not found' }); }

    // 2. Pinecone에서 관련 뉴스 기사 찾기
    const pinecone = new Pinecone();
    const index = pinecone.index('gcp-starter-gemini');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    
    const companyNameForEmbedding = kTickerInfo[ticker]?.name || ticker;
    const embeddingResult = await embeddingModel.embedContent(companyNameForEmbedding);
    const queryVector = embeddingResult.embedding.values;
    
    const queryResult = await index.query({ topK: 100, vector: queryVector, includeMetadata: true });
    const allFoundArticles = queryResult.matches.map(match => match.metadata);

    // 3. 데이터 가공
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
    
    response.status(200).json(finalData);

  } catch (error) {
    console.error('Details API Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
};