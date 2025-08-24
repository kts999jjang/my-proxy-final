// my-proxy-final/api/get-recommendations.js

import fetch from 'node-fetch';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { Redis } from '@upstash/redis';
import nlp from 'compromise';

// --- 상수 정의 (이전과 동일) ---
const kTickerInfo = { /* ... */ };

// --- API 호출 및 계산 함수들 (이전과 동일) ---
async function fetchStockDataFromYahoo(tickers) { /* ... */ }
async function getTickerForCompanyName(companyName) { /* ... */ }
function calculateSMA(data, period) { /* ... */ }
function calculateRSI(data, period = 14) { /* ... */ }

// --- 메인 핸들러 ---
export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  try {
    const { theme, style = 'leading' } = request.query;
    if (!theme) {
      return response.status(400).json({ error: 'Theme query parameter is required' });
    }

    const pinecone = new Pinecone({
        environment: process.env.PINECONE_ENVIRONMENT,
        apiKey: process.env.PINECONE_API_KEY,
    });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const index = pinecone.index('news-index');

    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: [theme], // 사용자가 선택한 테마 이름을 직접 사용
    });
    const queryVector = embeddingResponse.data[0].embedding;
    
    const queryResult = await index.query({
      topK: 200, 
      vector: queryVector,
      includeMetadata: true,
    });
    const similarArticles = queryResult.matches.map(match => match.metadata);
    
    if (similarArticles.length === 0) {
      return response.status(404).json({ error: 'Failed to find similar news articles for the theme.' });
    }

    const organizationCounts = {};
    similarArticles.forEach(article => {
      const doc = nlp(article.title);
      const organizations = doc.organizations().out('array');
      organizations.forEach(org => {
        const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
        organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1;
      });
    });

    const companyPromises = Object.keys(organizationCounts).map(orgName => getTickerForCompanyName(orgName));
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
        return response.status(404).json({ details: `Could not discover any stocks for the selected style (${style}).` });
    }

    const stockDataResults = await fetchStockDataFromYahoo(topTickers);

    if (stockDataResults.length === 0) {
        return response.status(404).json({ details: 'Successfully found a theme, but failed to fetch stock data.' });
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
        const relevantArticles = similarArticles.filter(a => searchKeywords.some(kw => a.title.toLowerCase().includes(kw))).slice(0, 5);

        return { ticker, companyName, latestPrice: quotes.length > 0 ? quotes[quotes.length-1] : 0, chartData, timestamps, smaShortData, smaLongData, rsi: rsi14, trendingTheme: theme, relevantArticles, dailyNewsStats: {}, topKeywords: [] };
    }).filter(Boolean);

    response.status(200).json({
      recommendations,
      trendingTheme: theme,
      totalArticles: similarArticles.length,
    });

  } catch (error) {
    console.error('Server Error in get-recommendations:', error);
    response.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}