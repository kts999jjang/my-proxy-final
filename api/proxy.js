// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');

// --- 상수 정의 ---

const kInvestmentThemes = {
  '인공지능(AI)': {
    query: '"artificial intelligence" OR "AI" OR "machine learning" OR nvidia OR openai',
    tickers: { leading: ['NVDA', 'MSFT'], growth: ['AI', 'PLTR'] }
  },
  '메타버스 & VR': {
    query: 'metaverse OR "virtual reality" OR "augmented reality" OR meta OR appl',
    tickers: { leading: ['META', 'AAPL'], growth: ['RBLX', 'U'] }
  },
  '전기차 & 자율주행': {
    query: '"electric vehicle" OR "self-driving" OR tesla OR rivian OR lucid',
    tickers: { leading: ['TSLA', 'RIVN'], growth: ['LCID', 'GM'] }
  },
  '클라우드 컴퓨팅': {
    query: '"cloud computing" OR aws OR "amazon web services" OR "google cloud" OR azure',
    tickers: { leading: ['AMZN', 'GOOGL'], growth: ['SNOW', 'CRWD'] }
  }
};

const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'gpu', 'ai chip'] },
  'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'azure', 'openai'] },
  'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'enterprise ai'] },
  'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'data analysis'] },
  'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'facebook', 'quest'] },
  'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'vision pro', 'iphone'] },
  'RBLX': { name: 'Roblox Corporation', keywords: ['roblox', 'gaming'] },
  'U': { name: 'Unity Software Inc.', keywords: ['unity', 'game engine'] },
  'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla', 'model y', 'cybertruck'] },
  'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian', 'r1t', 'electric truck'] },
  'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid', 'air', 'ev'] },
  'GM': { name: 'General Motors Company', keywords: ['gm', 'cruise', 'ultium'] },
  'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'aws', 'cloud'] },
  'GOOGL': { name: 'Alphabet Inc.', keywords: ['google', 'gcp', 'cloud'] },
  'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake', 'data cloud'] },
  'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike', 'cybersecurity'] }
};


// --- API 호출 함수 ---

async function fetchNewsForTheme(themeName, themeQuery, analysisDays) {
  const fromDate = new Date(Date.now() - analysisDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const newsApiKey = process.env.NEWS_API_KEY;
  const gnewsApiKey = process.env.GNEWS_API_KEY;

  try {
    // NewsAPI 먼저 시도
    if (!newsApiKey) throw new Error('NEWS_API_KEY is not set.');
    const url = `https://newsapi.org/v2/everything?q=(${themeQuery})&from=${fromDate}&sortBy=popularity&language=en&pageSize=100&apiKey=${newsApiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NewsAPI request failed with status ${response.status}`);
    const data = await response.json();
    return {
      themeName,
      totalResults: data.totalResults || 0,
      articles: data.articles.map(a => ({ title: a.title || '' })),
    };
  } catch (error) {
    console.warn(`NewsAPI failed for theme "${themeName}", trying GNews. Reason: ${error.message}`);
    // GNews로 폴백
    if (!gnewsApiKey) throw new Error('GNEWS_API_KEY is not set.');
    const url = `https://gnews.io/api/v4/search?q=(${themeQuery})&lang=en&max=100&apikey=${gnewsApiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GNews request failed with status ${response.status}`);
    const data = await response.json();
    return {
      themeName,
      totalResults: data.totalArticles || 0,
      articles: data.articles.map(a => ({ title: a.title || '' })),
    };
  }
}

// ✨ Yahoo Finance 오류 로깅이 강화된 함수
async function fetchStockDataFromYahoo(tickers) {
  if (!tickers || tickers.length === 0) return [];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${tickers.join(',')}?range=1mo&interval=1d`;
  const response = await fetch(url);
  
  if (!response.ok) {
    // 오류 발생 시, Yahoo Finance가 보낸 실제 오류 메시지를 로그에 남깁니다.
    const errorBody = await response.text();
    console.error(`Yahoo Finance API Error: Status ${response.status}`, errorBody);
    throw new Error(`Failed to fetch from Yahoo Finance with status: ${response.status}`);
  }

  const data = await response.json();
  // 데이터가 비어있는 경우를 대비한 방어 코드 추가
  return data?.chart?.result || [];
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

    const themePromises = Object.entries(kInvestmentThemes).map(([themeName, themeData]) =>
      fetchNewsForTheme(themeName, themeData.query, parseInt(analysisDays))
    );
    const themeResults = await Promise.all(themePromises);

    const topTheme = themeResults.sort((a, b) => b.totalResults - a.totalResults)[0];
    
    if (!topTheme || topTheme.totalResults < 5) { // 최소 5개 이상일 때만 유효한 트렌드로 간주
      return response.status(404).json({
        error: 'Failed to process request',
        details: 'Could not determine a significant trending theme.'
      });
    }

    const trendingThemeName = topTheme.themeName;
    const allArticles = topTheme.articles;
    const themeTickers = kInvestmentThemes[trendingThemeName].tickers[style];
    const stockDataResults = await fetchStockDataFromYahoo(themeTickers);

    const recommendations = stockDataResults.map(stockData => {
      if (!stockData || !stockData.meta) return null; // 방어 코드
      
      const ticker = stockData.meta.symbol;
      const timestamps = stockData.timestamp || [];
      const quotes = stockData.indicators?.quote?.[0]?.close || [];
      const chartData = timestamps.map((ts, i) => ({ x: i, y: quotes[i] })).filter(d => d.y != null);
      
      const searchKeywords = kTickerInfo[ticker]?.keywords || [ticker.toLowerCase()];
      const relevantArticles = allArticles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw))).slice(0, 5);

      return {
        ticker,
        companyName: kTickerInfo[ticker]?.name || ticker,
        latestPrice: chartData.length > 0 ? chartData[chartData.length - 1].y : 0,
        chartData,
        trendingTheme: trendingThemeName,
        relevantArticles,
      };
    }).filter(Boolean); // null 값 제거

    response.status(200).json({
      recommendations,
      trendingTheme: trendingThemeName,
      totalArticles: allArticles.length,
    });

  } catch (error) {
    console.error('Server Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
};