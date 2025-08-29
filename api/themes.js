// my-proxy-final/api/themes.js

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- 상수 정의 ---
const kInvestmentThemes = {
  '인공지능(AI)': { query: '"artificial intelligence" OR "semiconductor" OR "machine learning" OR "NVIDIA"', },
  '메타버스 & VR': { query: '"metaverse" OR "virtual reality" OR "augmented reality" OR "Roblox" OR "Unity"', },
  '전기차 & 자율주행': { query: '"electric vehicle" OR "self-driving" OR "autonomous car" OR "Tesla" OR "Rivian"', },
  '클라우드 컴퓨팅': { query: '"cloud computing" OR "data center" OR "SaaS" OR "Amazon AWS" OR "Microsoft Azure"', },
  '바이오/헬스케어': { query: '"biotechnology" OR "healthcare" OR "pharmaceutical" OR "clinical trial"', },
  '엔터테인먼트/미디어': { query: '"entertainment" OR "streaming" OR "media" OR "Disney" OR "Netflix"', },
  '친환경/에너지': { query: '"renewable energy" OR "solar power" OR "wind power" OR "clean energy"', },
};

const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'], style: 'leading' }, 'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'], style: 'leading' }, 'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'], style: 'growth' }, 'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'], style: 'growth' }, 'AMD': { name: 'Advanced Micro Devices', keywords: ['amd', 'advanced micro devices'], style: 'growth' }, 'META': { name: 'Meta Platforms, Inc.', keywords: ['meta', 'meta platforms', 'facebook'], style: 'leading' }, 'AAPL': { name: 'Apple Inc.', keywords: ['apple', 'apple inc'], style: 'leading' }, 'RBLX': { name: 'Roblox Corporation', keywords: ['roblox'], style: 'growth' }, 'U': { name: 'Unity Software Inc.', keywords: ['unity', 'unity software'], style: 'growth' }, 'SNAP': { name: 'Snap Inc.', keywords: ['snap inc', 'snapchat'], style: 'growth' }, 'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla'], style: 'leading' }, 'RIVN': { name: 'Rivian Automotive, Inc.', keywords: ['rivian', 'r1t', 'electric truck'], style: 'growth' }, 'LCID': { name: 'Lucid Group, Inc.', keywords: ['lucid', 'air', 'ev'], style: 'growth' }, 'GM': { name: 'General Motors Company', keywords: ['gm', 'general motors'], style: 'leading' }, 'F': { name: 'Ford Motor Company', keywords: ['ford'], style: 'leading' }, 'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'amazon.com'], style: 'leading' }, 'GOOGL': { name: 'Alphabet Inc.', keywords: ['alphabet', 'google'], style: 'leading' }, 'SNOW': { name: 'Snowflake Inc.', keywords: ['snowflake', 'data cloud'], style: 'growth' }, 'CRWD': { name: 'CrowdStrike Holdings', keywords: ['crowdstrike', 'cybersecurity'], style: 'growth' }, 'MRNA': { name: 'Moderna, Inc.', keywords: ['moderna'], style: 'growth' }, 'PFE': { name: 'Pfizer Inc.', keywords: ['pfizer'], style: 'leading' }, 'DIS': { name: 'The Walt Disney Company', keywords: ['disney'], style: 'leading' }, 'NFLX': { name: 'Netflix, Inc.', keywords: ['netflix'], style: 'leading' }
};

async function getTickerForCompanyName(companyName, redis) {
  const cleanedName = companyName.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
  const cachedTicker = await redis.get(cleanedName);
  if (cachedTicker) { return cachedTicker; }
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

module.exports = async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (request.method === 'OPTIONS') { return response.status(200).end(); }

  try {
    const { themes = '인공지능(AI)' } = request.query;
    const selectedThemeNames = themes.split(',');
    
    if (selectedThemeNames.length === 0 || selectedThemeNames[0] === '') {
        return response.status(200).json({ results: {} });
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 14); // 목록 추천은 14일 기준으로 고정 (속도 최적화)
    
    const pinecone = new Pinecone(); 
    const index = pinecone.index('gcp-starter-gemini');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const finalResults = {};

    const analysisPromises = selectedThemeNames.map(async (themeName) => {
      const themeData = kInvestmentThemes[themeName];
      if (!themeData) return null;

      const today = new Date().toISOString().split('T')[0];
      const cacheKey = `summary:${themeName}:${today}`;
      let themeSentence = await redis.get(cacheKey);
      
      if (!themeSentence) {
        const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(themeData.query)}&topic=business,technology&lang=en&max=50&from=${fromDate.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
        const latestNewsResponse = await fetch(gnewsUrl);
        const latestNews = await latestNewsResponse.json();
        if (!latestNews.articles || latestNews.articles.length === 0) return null;
        
        const headlines = latestNews.articles.map(a => a.title).join('\n');
        const prompt = `Summarize the key trend within the '${themeName}' theme from these headlines in one objective sentence:\n\n${headlines}`;
        const result = await geminiModel.generateContent(prompt);
        themeSentence = result.response.text();
        await redis.set(cacheKey, themeSentence, { ex: 43200 });
      }

      const embeddingResult = await embeddingModel.embedContent(themeSentence);
      const queryVector = embeddingResult.embedding.values;
      
      const queryResult = await index.query({ 
        topK: 200, vector: queryVector, includeMetadata: true,
        filter: { "publishedAt": { "$gte": fromDate.getTime() / 1000 } }
      });
      const allFoundArticles = queryResult.matches.map(match => match.metadata);
      if (allFoundArticles.length === 0) return null;
      
      const organizationCounts = {};
      allFoundArticles.forEach(article => {
        const doc = nlp(article.title);
        doc.organizations().out('array').forEach(org => {
          const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
          if (orgName.length > 1) {
            organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
          }
        });
      });

      const themeTickerScores = {};
      const tickerPromises = Object.keys(organizationCounts).map(async (orgName) => {
          const ticker = await getTickerForCompanyName(orgName, redis);
          if (ticker) {
            themeTickerScores[ticker] = (themeTickerScores[ticker] || 0) + organizationCounts[orgName];
          }
      });
      await Promise.all(tickerPromises);

      if (Object.keys(themeTickerScores).length === 0) return null;
      
      const sortedTickers = Object.entries(themeTickerScores).sort(([,a],[,b]) => b-a);
      const leadingStocks = sortedTickers.filter(([t]) => kTickerInfo[t]?.style === 'leading').slice(0, 5).map(([t]) => ({ticker: t, companyName: kTickerInfo[t]?.name || t}));
      const growthStocks = sortedTickers.filter(([t]) => kTickerInfo[t]?.style === 'growth').slice(0, 5).map(([t]) => ({ticker: t, companyName: kTickerInfo[t]?.name || t}));
      
      return { themeName, data: { leading: leadingStocks, growth: growthStocks } };
    });

    const analysisResults = (await Promise.all(analysisPromises)).filter(Boolean);
    for (const result of analysisResults) {
        if (result) {
            finalResults[result.themeName] = result.data;
        }
    }

    response.status(200).json({ results: finalResults });

  } catch (error) {
    console.error('Server Error:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
};