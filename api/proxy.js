// my-proxy-final/api/proxy.js

import fetch from 'node-fetch';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { Redis } from '@upstash/redis';
import nlp from 'compromise';

// --- 상수 정의 ---
const kInvestmentThemes = {
  '인공지능(AI)': {
    query: 'The future of artificial intelligence, semiconductor chips, and machine learning models.',
  },
  '메타버스 & VR': {
    query: 'Trends in metaverse platforms, virtual reality headsets, and augmented reality applications.',
  },
  '전기차 & 자율주행': {
    query: 'The market for electric vehicles, self-driving car technology, and battery innovation.',
  },
  '클라우드 컴퓨팅': {
    query: 'Growth in cloud computing, data centers, and enterprise software as a service (SaaS).',
  }
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
  'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike', 'cybersecurity'], style: 'growth' }
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
  if (cachedTicker) {
    console.log(`[CACHE HIT] Found ticker for "${cleanedName}": ${cachedTicker}`);
    return cachedTicker;
  }
  console.log(`[CACHE MISS] Searching ticker for "${cleanedName}" via API...`);
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
  for (let i = 0; i < period - 1; i++) {
    result.push(null);
  }
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
    if (diff >= 0) {
      gains.push(diff);
      losses.push(0);
    } else {
      gains.push(0);
      losses.push(-diff);
    }
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
export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    const { style = 'leading' } = request.query;

    const pinecone = new Pinecone({
        environment: process.env.PINECONE_ENVIRONMENT,
        apiKey: process.env.PINECONE_API_KEY,
    });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const index = pinecone.index('news-index');

    // 1. 모든 테마에 대해 동시 분석 실행
    const themeAnalysisPromises = Object.entries(kInvestmentThemes).map(async ([themeName, themeData]) => {
      // 각 테마의 쿼리 문장을 벡터로 변환
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: [themeData.query],
      });
      const queryVector = embeddingResponse.data[0].embedding;
      
      // Pinecone에서 유사 뉴스 검색
      const queryResult = await index.query({
        topK: 100, // 각 테마별로 가장 관련성 높은 뉴스 100개 검색
        vector: queryVector,
        includeMetadata: true,
      });
      const similarArticles = queryResult.matches.map(match => match.metadata);

      // NLP로 종목 발굴
      const organizationCounts = {};
      similarArticles.forEach(article => {
        const doc = nlp(article.title);
        const organizations = doc.organizations().out('array');
        organizations.forEach(org => {
          const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
          organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
        });
      });
      return { themeName, articles: similarArticles, organizations: organizationCounts };
    });

    const analysisResults = await Promise.all(themeAnalysisPromises);

    // 2. 모든 테마에서 발굴된 종목들을 하나로 합치고 점수 계산
    const globalTickerScores = {};
    for (const result of analysisResults) {
        const companyPromises = Object.keys(result.organizations).map(orgName => getTickerForCompanyName(orgName));
        const resolvedTickers = await Promise.all(companyPromises);
        const validTickers = resolvedTickers.filter(Boolean);
        validTickers.forEach(ticker => {
            globalTickerScores[ticker] = (globalTickerScores[ticker] || 0) + 1;
        });
    }

    if (Object.keys(globalTickerScores).length === 0) {
        return response.status(404).json({
            error: 'Failed to process request',
            details: 'Could not discover any stocks from all themes.'
        });
    }
    
    // 3. 최종 후보군을 스타일로 필터링하고 상위 종목 선정
    const topTickers = Object.entries(globalTickerScores)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0])
      .filter(ticker => kTickerInfo[ticker]?.style === style)
      .filter(ticker => ticker !== 'AI') // ✨ 'AI' 티커를 제외하는 테스트 필터
      .slice(0, 3);
    
    if (topTickers.length === 0) {
        return response.status(404).json({
            error: 'Failed to process request',
            details: `Could not discover any stocks for the selected style (${style}).`
        });
    }

    // 4. 주가 데이터 조회 및 최종 응답 생성
    const stockDataResults = await fetchStockDataFromYahoo(topTickers);
    const topThemeName = analysisResults.sort((a, b) => b.articles.length - a.articles.length)[0].themeName;
    const allFoundArticles = analysisResults.flatMap(r => r.articles);
    
    if (stockDataResults.length === 0) {
        return response.status(404).json({
            error: 'Failed to process request',
            details: 'Successfully found themes, but failed to fetch stock data for top tickers.'
        });
    }

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
        const relevantArticles = allFoundArticles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw))).slice(0, 5);

        return { ticker, companyName, latestPrice: quotes.length > 0 ? quotes[quotes.length-1] : 0, chartData, timestamps, smaShortData, smaLongData, rsi: rsi14, trendingTheme: topThemeName, relevantArticles };
    }).filter(Boolean);

    response.status(200).json({
      recommendations,
      trendingTheme: topThemeName,
      totalArticles: allFoundArticles.length,
    });

  } catch (error) {
    console.error('Server Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}