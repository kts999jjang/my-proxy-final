// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');

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


// --- API 호출 및 계산 함수들 (기존과 동일) ---
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
module.exports = async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    const { analysisDays = '14', style = 'leading' } = request.query;
    
    // ✨ CHANGED: analysisDays를 사용하여 GNews 검색 시작 날짜 계산
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - parseInt(analysisDays, 10));
    const fromISO = fromDate.toISOString();

    const pinecone = new Pinecone({
        environment: process.env.PINECONE_ENVIRONMENT,
        apiKey: process.env.PINECONE_API_KEY,
    });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const index = pinecone.index('news-index');

    const themeAnalysisPromises = Object.entries(kInvestmentThemes).map(async ([themeName, themeData]) => {
      // ✨ CHANGED: GNews API 호출 시 'from' 파라미터 추가
      const gnewsUrl = `https://gnews.io/api/v4/search?q=(${themeData.query})&topic=business,technology&lang=en&max=10&from=${fromISO}&apikey=${process.env.GNEWS_API_KEY}`;
      const latestNewsResponse = await fetch(gnewsUrl);
      const latestNews = await latestNewsResponse.json();
      if (!latestNews.articles || latestNews.articles.length === 0) return { themeName, tickers: {}, articles: [] };
      
      const headlines = latestNews.articles.map(a => a.title).join('\n');
      
      const chatResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Summarize the key trend within the '${themeName}' theme from these headlines in one objective sentence:\n\n${headlines}`
        }],
      });
      const themeSentence = chatResponse.choices[0].message.content;

      const embeddingResponse = await openai.embeddings.create({ model: 'text-embedding-3-small', input: [themeSentence] });
      const queryVector = embeddingResponse.data[0].embedding;
      
      // ✨ CHANGED: Pinecone 검색 결과도 날짜로 필터링 (메타데이터에 'publishedAt'이 있다는 가정)
      const queryResult = await index.query({ 
        topK: 100, 
        vector: queryVector, 
        includeMetadata: true,
        filter: {
          "publishedAt": { "$gte": fromDate.getTime() / 1000 } // Pinecone은 초 단위 타임스탬프를 사용할 수 있음
        }
      });
      const similarArticles = queryResult.matches.map(match => match.metadata);

      const organizationCounts = {};
      const blacklist = new Set(['ai', 'corp', 'inc', 'ltd', 'llc', 'co', 'group']);
      similarArticles.forEach(article => {
        const doc = nlp(article.title);
        const organizations = doc.organizations().out('array');
        organizations.forEach(org => {
          const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
          if (!blacklist.has(orgName) && orgName.length > 1) {
            organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
          }
        });
      });
      return { themeName, articles: similarArticles, organizations: organizationCounts };
    });

    const analysisResults = await Promise.all(themeAnalysisPromises);
    const globalTickerScores = {};
    for (const result of analysisResults) {
        if (!result.organizations) continue;
        const companyPromises = Object.keys(result.organizations)
            .map(async (orgName) => {
                const ticker = await getTickerForCompanyName(orgName);
                return { ticker, count: result.organizations[orgName] };
            });
        const resolvedTickers = await Promise.all(companyPromises);
        
        resolvedTickers.forEach(({ ticker, count }) => {
            if (ticker) {
                globalTickerScores[ticker] = (globalTickerScores[ticker] || 0) + count;
            }
        });
    }

    if (Object.keys(globalTickerScores).length === 0) {
        return response.status(404).json({ details: 'Could not discover any stocks from all themes.' });
    }
    
    const topTickers = Object.entries(globalTickerScores)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0])
      .filter(ticker => kTickerInfo[ticker]?.style === style)
      .slice(0, 3);
    
    if (topTickers.length === 0) {
        return response.status(404).json({ details: `Could not discover any stocks for the selected style (${style}).` });
    }

    const stockDataResults = await fetchStockDataFromYahoo(topTickers);
    const topThemeName = analysisResults.sort((a, b) => Object.keys(b.organizations).length - Object.keys(a.organizations).length)[0].themeName;
    const allFoundArticles = analysisResults.flatMap(r => r.articles);
    
    if (stockDataResults.length === 0) {
        return response.status(404).json({ details: 'Successfully found themes, but failed to fetch stock data for top tickers.' });
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
        
        // ✨ NEW: 특정 종목의 모든 관련 기사 필터링
        const relevantArticles = allFoundArticles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw)));
        
        // ✨ NEW: dailyNewsStats 계산
        const dailyNewsStats = {};
        relevantArticles.forEach(article => {
            if (article.publishedAt) {
                const date = new Date(article.publishedAt * 1000).toISOString().split('T')[0];
                dailyNewsStats[date] = (dailyNewsStats[date] || 0) + 1;
            }
        });

        // ✨ NEW: topKeywords 계산
        const titleText = relevantArticles.map(a => a.title).join(' ');
        const doc = nlp(titleText);
        const topKeywords = doc.nouns().out('freq')
                               .filter(item => item.normal.length > 2 && isNaN(item.normal))
                               .slice(0, 10)
                               .map(item => item.normal);
        
        return {
          ticker,
          companyName,
          latestPrice: quotes.length > 0 ? quotes[quotes.length-1] : 0,
          chartData,
          timestamps,
          smaShortData,
          smaLongData,
          rsi: rsi14,
          trendingTheme: topThemeName,
          relevantArticles: relevantArticles.slice(0, 5), // 프론트엔드에는 5개만 전송
          dailyNewsStats, // ✨ NEW
          topKeywords,    // ✨ NEW
        };
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
};