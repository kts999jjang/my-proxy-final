// my-proxy-final/api/proxy.js

const fetch = require('node-fetch');

// 상수와 테마 정의
const kTickerInfo = {
  'NVDA': { name: 'NVIDIA', keywords: ['nvidia', 'gpu', 'geforce'] },
  'MSFT': { name: 'Microsoft', keywords: ['microsoft', 'azure', 'windows'] },
  'AVGO': { name: 'Broadcom', keywords: ['broadcom', 'avgo'] },
  'AMD':  { name: 'AMD', keywords: ['amd', 'ryzen', 'epyc'] },
  'QCOM': { name: 'Qualcomm', keywords: ['qualcomm', 'snapdragon'] },
  'SMCI': { name: 'Super Micro Computer', keywords: ['smci', 'supermicro'] },
  'AMZN': { name: 'Amazon', keywords: ['amazon', 'aws'] },
  'GOOGL':{'name': 'Google', keywords: ['google', 'alphabet', 'android'] },
  'CRM':  { name: 'Salesforce', keywords: ['salesforce', 'crm'] },
  'ADBE': { name: 'Adobe', keywords: ['adobe', 'photoshop'] },
  'SNOW': {'name': 'Snowflake', keywords: ['snowflake', 'snow'] },
  'TSLA': {'name': 'Tesla', keywords: ['tesla', 'elon musk'] },
  'RIVN': {'name': 'Rivian', keywords: ['rivian'] },
  'LCID': {'name': 'Lucid', keywords: ['lucid'] },
  'PLUG': {'name': 'Plug Power', keywords: ['plug power', 'hydrogen'] },
  'CRWD': {'name': 'CrowdStrike', keywords: ['crowdstrike', 'cybersecurity'] },
  'PANW': {'name': 'Palo Alto Networks', keywords: ['palo alto networks'] },
  'ZS':   {'name': 'Zscaler', keywords: ['zscaler'] },
  'NFLX': {'name': 'Netflix', keywords: ['netflix', 'streaming'] },
  'DIS':  {'name': 'Disney', keywords: ['disney'] },
  'ROKU': {'name': 'Roku', keywords: ['roku'] },
  'PARA': {'name': 'Paramount', keywords: ['paramount'] },
  'PFE':  {'name': 'Pfizer', keywords: ['pfizer'] },
  'JNJ':  {'name': 'Johnson & Johnson', keywords: ['johnson & johnson'] },
  'MRNA': {'name': 'Moderna', keywords: ['moderna', 'vaccine'] },
  'BNTX': {'name': 'BioNTech', keywords: ['biontech'] },
};

const kInvestmentThemes = {
  'AI & 반도체': {
    'keywords': ['ai', 'gpu', 'nvidia', 'amd', 'intel', 'semiconductor', 'chip', 'data center', 'machine learning', 'arm'],
    'tickers': { 'leading': ['NVDA', 'MSFT', 'AVGO'], 'growth': ['AMD', 'QCOM', 'SMCI'], }
  },
  '클라우드 & SaaS': {
    'keywords': ['cloud', 'saas', 'software', 'crm', 'adobe', 'oracle', 'salesforce', 'aws', 'azure', 'snow'],
    'tickers': { 'leading': ['MSFT', 'AMZN', 'GOOGL'], 'growth': ['CRM', 'ADBE', 'SNOW'], }
  },
  '전기차 & 자율주행': {
    'keywords': ['ev', 'electric vehicle', 'tesla', 'battery', 'self-driving', 'lidar', 'charging', 'rivian', 'lucid'],
    'tickers': { 'leading': ['TSLA', 'RIVN'], 'growth': ['LCID', 'PLUG'], }
  },
  '사이버 보안': {
    'keywords': ['cybersecurity', 'security', 'firewall', 'antivirus', 'crowdstrike'],
    'tickers': { 'leading': ['PANW'], 'growth': ['CRWD', 'ZS'], }
  },
  '스트리밍 & 미디어': {
    'keywords': ['streaming', 'netflix', 'disney', 'video', 'content'],
    'tickers': { 'leading': ['NFLX', 'DIS'], 'growth': ['ROKU', 'PARA'], }
  },
  '헬스케어 & 백신': {
    'keywords': ['healthcare', 'pharma', 'vaccine', 'pfizer', 'moderna', 'biotech'],
    'tickers': { 'leading': ['PFE', 'JNJ'], 'growth': ['MRNA', 'BNTX'], }
  }
};

// --- API 호출 함수들 ---
async function fetchNews(analysisDays) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) throw new Error('NEWS_API_KEY is not set.');
  const fromDate = new Date(Date.now() - analysisDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `https://newsapi.org/v2/everything?q=tech OR finance&from=${fromDate}&sortBy=popularity&language=en&pageSize=100&apiKey=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to load news');
  const data = await response.json();
  return data.articles.map(article => ({ title: article.title || '' }));
}

async function fetchStockDataFromYahoo(tickers) {
  if (!tickers || tickers.length === 0) return [];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${tickers.join(',')}?range=1mo&interval=1d`;
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
  if (!response.ok) throw new Error('Failed to fetch from Yahoo Finance');
  const data = await response.json();
  return data.chart.result || [];
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
    const { analysisDays = '14', style = 'leading' } = request.query;
    const articles = await fetchNews(parseInt(analysisDays));
    
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