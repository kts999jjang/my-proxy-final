// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');
const nlp = require('compromise'); // NLP 라이브러리 import

// --- 상수 정의 ---

const kInvestmentThemes = {
  '인공지능(AI)': {
    query: '"artificial intelligence" OR "AI" OR "machine learning" OR nvidia OR openai',
  },
  '메타버스 & VR': {
    query: 'metaverse OR "virtual reality" OR "augmented reality" OR meta OR appl',
  },
  '전기차 & 자율주행': {
    query: '"electric vehicle" OR "self-driving" OR tesla OR rivian OR lucid',
  },
  '클라우드 컴퓨팅': {
    query: '"cloud computing" OR aws OR "amazon web services" OR "google cloud" OR azure',
  }
};

// TickerInfo를 '회사명 -> 티커' 맵핑용으로 확장
const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'] },
  'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'] },
  'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'] },
  'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'] },
  'AMD': { name: 'Advanced Micro Devices', keywords: ['amd', 'advanced micro devices'] },
  'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'meta platforms', 'facebook'] },
  'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'apple inc'] },
  'RBLX': { name: 'Roblox Corporation', keywords: ['roblox'] },
  'U': { name: 'Unity Software Inc.', keywords: ['unity', 'unity software'] },
  'SNAP': { name: 'Snap Inc.', keywords: ['snap inc', 'snapchat'] },
  'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla'] },
  'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian'] },
  'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid'] },
  'GM': { name: 'General Motors Company', keywords: ['gm', 'general motors'] },
  'F': { name: 'Ford Motor Company', keywords: ['ford'] },
  'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'amazon.com'] },
  'GOOGL': { name: 'Alphabet Inc.', keywords: ['alphabet', 'google'] },
  'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake'] },
  'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike'] }
};


// --- API 호출 함수 ---

async function fetchNewsForTheme(themeName, themeQuery, analysisDays) {
  const fromDate = new Date(Date.now() - analysisDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const newsApiKey = process.env.NEWS_API_KEY;
  const gnewsApiKey = process.env.GNEWS_API_KEY;

  try {
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


// --- 메인 핸들러 ---
module.exports = async (request, response) => {
  // CORS 헤더 설정
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    const { analysisDays = '14' } = request.query;

    const themePromises = Object.entries(kInvestmentThemes).map(([themeName, themeData]) =>
      fetchNewsForTheme(themeName, themeData.query, parseInt(analysisDays))
    );
    const themeResults = await Promise.all(themePromises);
    const topTheme = themeResults.sort((a, b) => b.totalResults - a.totalResults)[0];
    
    if (!topTheme || topTheme.totalResults < 5) {
      return response.status(404).json({
        error: 'Failed to process request',
        details: 'Could not determine a significant trending theme.'
      });
    }

    const trendingThemeName = topTheme.themeName;
    const allArticles = topTheme.articles;

    const organizationCounts = {};
    allArticles.forEach(article => {
      const doc = nlp(article.title);
      const organizations = doc.organizations().out('array');
      organizations.forEach(org => {
        const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
        organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
      });
    });

    const tickerScores = {};
    for (const orgName in organizationCounts) {
      for (const ticker in kTickerInfo) {
        if (kTickerInfo[ticker].keywords.includes(orgName)) {
          tickerScores[ticker] = (tickerScores[ticker] || 0) + organizationCounts[orgName];
          break;
        }
      }
    }
    
    const topTickers = Object.entries(tickerScores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(entry => entry[0]);

    if (topTickers.length === 0) {
        return response.status(404).json({
            error: 'Failed to process request',
            details: 'Could not discover any stocks from news articles.'
        });
    }

    const stockDataResults = await fetchStockDataFromYahoo(topTickers);

    const recommendations = stockDataResults.map(stockData => {
        if (!stockData || !stockData.meta) return null;
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
      }).filter(Boolean);

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