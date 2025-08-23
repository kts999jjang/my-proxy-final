// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');
const nlp = require('compromise');
const { Redis } = require('@upstash/redis');

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


// --- API 호출 함수들 ---

async function fetchNewsForTheme(themeName, themeQuery, analysisDays) {
  const fromDate = new Date(Date.now() - analysisDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const newsApiKey = process.env.NEWS_API_KEY;
  const gnewsApiKey = process.env.GNEWS_API_KEY;
  const maxArticlesToFetch = 500;
  const pageSize = 100;

  try {
    if (!newsApiKey) throw new Error('NEWS_API_KEY is not set.');
    
    const fetchLanguage = async (lang) => {
      let allArticles = [];
      let totalResults = 0;
      let page = 1;
      
      while (allArticles.length < maxArticlesToFetch) {
        const url = `https://newsapi.org/v2/everything?q=(${themeQuery})&from=${fromDate}&sortBy=popularity&language=${lang}&pageSize=${pageSize}&page=${page}&apiKey=${newsApiKey}`;
        const response = await fetch(url);
        if (!response.ok) {
           if (response.status === 426) {
               console.warn(`NewsAPI(${lang}) upgrade required to access more pages. Stopping at page ${page-1}.`);
               break; 
           }
           throw new Error(`NewsAPI(${lang}) request failed at page ${page} with status ${response.status}`);
        }
        
        const data = await response.json();
        if (page === 1) {
            totalResults = data.totalResults || 0;
        }

        const fetchedArticles = data.articles || [];
        if (fetchedArticles.length === 0) {
            break;
        }
        allArticles.push(...fetchedArticles);
        
        if (allArticles.length >= totalResults || allArticles.length >= maxArticlesToFetch) {
            break;
        }
        page++;
      }
      return { articles: allArticles, totalResults };
    };

    const [enResult, koResult] = await Promise.all([fetchLanguage('en'), fetchLanguage('ko')]);

    const combinedArticles = [...enResult.articles, ...koResult.articles];
    const combinedTotalResults = enResult.totalResults + koResult.totalResults;

    if (combinedArticles.length === 0) throw new Error('All NewsAPI requests failed to return articles.');
    
    return {
      themeName,
      totalResults: combinedTotalResults,
      articles: combinedArticles.map(a => ({
        title: a.title || '',
        url: a.url,
        source: a.source?.name,
        publishedAt: a.publishedAt,
      })),
    };

  } catch (error) {
    console.warn(`NewsAPI process failed for theme "${themeName}", trying GNews. Reason: ${error.message}`);
    if (!gnewsApiKey) throw new Error('GNEWS_API_KEY is not set.');
    const gnewsQuery = `(${themeQuery})&topic=business,technology,science,health`;
    const url = `https://gnews.io/api/v4/search?q=${gnewsQuery}&lang=en&max=100&apikey=${gnewsApiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GNews request failed with status ${response.status}`);
    const data = await response.json();
    return {
      themeName,
      totalResults: data.totalArticles || 0,
      articles: data.articles.map(a => ({
        title: a.title || '',
        url: a.url,
        source: a.source?.name,
        publishedAt: a.publishedAt,
      })),
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

    const companyPromises = Object.keys(organizationCounts)
        .map(orgName => getTickerForCompanyName(orgName));
    
    const resolvedTickers = await Promise.all(companyPromises);
    const validTickers = resolvedTickers.filter(Boolean);

    const tickerScores = {};
    validTickers.forEach(ticker => {
        tickerScores[ticker] = (tickerScores[ticker] || 0) + 1;
    });

    const topTickers = Object.entries(tickerScores)
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0])
      .filter(ticker => kTickerInfo[ticker]?.style === style)
      .slice(0, 3);

    if (topTickers.length === 0) {
        return response.status(404).json({
            error: 'Failed to process request',
            details: `Could not discover any stocks for the selected style (${style}).`
        });
    }

    const stockDataResults = await fetchStockDataFromYahoo(topTickers);

    if (stockDataResults.length === 0) {
      return response.status(404).json({
          error: 'Failed to process request',
          details: 'Successfully found a theme, but failed to fetch stock data.'
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
      const allRelatedArticles = allArticles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw)));
      
      const dailyCounts = {};
      allRelatedArticles.forEach(article => {
        if (!article.publishedAt) return;
        const date = new Date(article.publishedAt).toISOString().split('T')[0];
        dailyCounts[date] = (dailyCounts[date] || 0) + 1;
      });

      const wordCounts = {};
      const stopWords = ['a', 'an', 'the', 'in', 'on', 'for', 'with', 'of', 'to', 'is', 'and', 'or', ...searchKeywords];
      allRelatedArticles.forEach(article => {
        const words = article.title.toLowerCase().replace(/'s/g, '').replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        words.forEach(word => {
          if (word.length > 2 && !stopWords.includes(word) && isNaN(word)) {
            wordCounts[word] = (wordCounts[word] || 0) + 1;
          }
        });
      });
      
      return {
        ticker,
        companyName,
        latestPrice: quotes.length > 0 ? quotes[quotes.length - 1] : 0,
        chartData,
        timestamps,
        smaShortData,
        smaLongData,
        rsi: rsi14,
        trendingTheme: trendingThemeName,
        relevantArticles: allRelatedArticles.slice(0, 5),
        dailyNewsStats: dailyCounts,
        topKeywords: Object.entries(wordCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]),
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