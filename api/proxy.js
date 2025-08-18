// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');

// ... (기존 kTickerInfo, kInvestmentThemes 상수는 동일) ...
const kTickerInfo = { /* 이전과 동일 */ };
const kInvestmentThemes = { /* 이전과 동일 */ };


// --- API 호출 함수들 ---

// 1. NewsAPI 호출 함수 (기존 함수 약간 수정)
async function fetchFromNewsAPI(analysisDays) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) throw new Error('NEWS_API_KEY is not set.');
  
  const fromDate = new Date(Date.now() - analysisDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `https://newsapi.org/v2/everything?q=tech OR finance&from=${fromDate}&sortBy=popularity&language=en&pageSize=100&apiKey=${apiKey}`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load news from NewsAPI');
  
  const data = await response.json();
  // ✨ 중요: 데이터 형식을 { title: ... } 로 통일합니다.
  return data.articles.map(article => ({ title: article.title || '' }));
}

// 2. GNews 호출 함수 (새로 추가)
async function fetchFromGNews(analysisDays) {
  const apiKey = process.env.GNEWS_API_KEY; // GNews용 환경 변수
  if (!apiKey) throw new Error('GNEWS_API_KEY is not set.');

  // GNews는 기간을 직접 지정하지 않고, '지난 14일' 같은 표현을 지원하지 않으므로, 키워드 중심으로 검색
  const url = `https://gnews.io/api/v4/search?q=technology OR finance&lang=en&max=100&apikey=${apiKey}`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load news from GNews');

  const data = await response.json();
  // ✨ 중요: 데이터 형식을 { title: ... } 로 통일합니다.
  return data.articles.map(article => ({ title: article.title || '' }));
}

// 3. 여러 소스를 순차적으로 호출하는 메인 함수 (새로 추가)
async function fetchNewsFromMultipleSources(analysisDays) {
  try {
    console.log('Attempting to fetch from NewsAPI...');
    const articles = await fetchFromNewsAPI(analysisDays);
    console.log('Successfully fetched from NewsAPI.');
    return articles;
  } catch (error) {
    console.warn('Failed to fetch from NewsAPI, trying GNews...', error.message);
    try {
      const articles = await fetchFromGNews(analysisDays);
      console.log('Successfully fetched from GNews as a fallback.');
      return articles;
    } catch (fallbackError) {
      console.error('Failed to fetch from all news sources.', fallbackError.message);
      throw new Error('All news sources are currently unavailable.');
    }
  }
}

async function fetchStockDataFromYahoo(tickers) {
  // ... (이전과 동일) ...
}

// --- 메인 핸들러 ---
module.exports = async (request, response) => {
  // CORS 헤더 설정 (이전과 동일)
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    const { analysisDays = '14', style = 'leading' } = request.query;
    
    // 4. 메인 핸들러에서 새로운 함수를 호출하도록 수정
    const articles = await fetchNewsFromMultipleSources(parseInt(analysisDays));
    
    // ... (이하 로직은 이전과 동일) ...
    const themeScores = {};
    for (const themeName in kInvestmentThemes) {
      const themeKeywords = kInvestmentThemes[themeName].keywords;
      themeScores[themeName] = articles.reduce((score, article) => {
        const title = article.title.toLowerCase();
        return score + themeKeywords.filter(kw => title.includes(kw)).length;
      }, 0);
    }
    const trendingThemeName = Object.entries(themeScores).sort((a, b) => b[1] - a[1])[0][0];
    
    const themeTickers = kInvestmentThemes[trendingThemeName].tickers[style];
    const stockDataResults = await fetchStockDataFromYahoo(themeTickers);

    const recommendations = stockDataResults.map(stockData => {
        const ticker = stockData.meta.symbol;
        const timestamps = stockData.timestamp || [];
        const quotes = stockData.indicators.quote[0]?.close || [];
        const chartData = timestamps.map((ts, i) => ({ x: i, y: quotes[i] })).filter(d => d.y != null);
        
        const searchKeywords = kTickerInfo[ticker]?.keywords || [ticker.toLowerCase()];
        const relevantArticles = articles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw))).slice(0, 5);

        return {
            ticker,
            companyName: kTickerInfo[ticker]?.name || ticker,
            latestPrice: chartData.length > 0 ? chartData[chartData.length - 1].y : 0,
            chartData,
            trendingTheme: trendingThemeName,
            relevantArticles,
        };
    });

    response.status(200).json({
      recommendations,
      trendingTheme: trendingThemeName,
      totalArticles: articles.length,
    });

  } catch (error) {
    console.error('Server Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
};