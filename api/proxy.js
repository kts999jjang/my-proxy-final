// my-proxy-final/api/proxy.js

// ✨ 환경 변수를 사용하기 위해 dotenv 패키지 import
// Vercel과 같은 호스팅 환경에서는 자동으로 환경 변수를 주입해주므로 이 설정이 필요 없을 수 있습니다.
require('dotenv').config();

const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');

// --- ✨ 환경 변수에서 민감 정보 로드 ---
// 코드에 직접 키를 작성하는 대신, process.env 객체를 통해 안전하게 불러옵니다.
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
  environment: process.env.PINECONE_ENVIRONMENT
});
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

// --- 상수 정의 ---
const kInvestmentThemes = {
  '인공지능(AI)': { query: 'The future of artificial intelligence, semiconductor chips, and machine learning models.' },
  '메타버스 & VR': { query: 'Trends in metaverse platforms, virtual reality headsets, and augmented reality applications.' },
  '전기차 & 자율주행': { query: 'The market for electric vehicles, self-driving car technology, and battery innovation.' },
  '클라우드 컴퓨팅': { query: 'Growth in cloud computing, data centers, and enterprise software as a service (SaaS).' }
};
const kTickerInfo = {
  'NVDA': { name: 'NVIDIA Corp', keywords: ['nvidia', 'nvidia corp'], style: 'leading' },
  'MSFT': { name: 'Microsoft Corp', keywords: ['microsoft', 'microsoft corp'], style: 'leading' },
  'AI': { name: 'C3.ai, Inc.', keywords: ['c3.ai', 'c3 ai'], style: 'growth' },
  'PLTR': { name: 'Palantir Technologies', keywords: ['palantir', 'palantir technologies'], style: 'growth' },
  'TSLA': { name: 'Tesla, Inc.', keywords: ['tesla', 'tesla inc'], style: 'leading' },
  'RIVN': { name: 'Rivian Automotive', keywords: ['rivian', 'rivian automotive'], style: 'growth' },
  'U': { name: 'Unity Software', keywords: ['unity', 'unity software'], style: 'growth' },
  'RBLX': { name: 'Roblox Corp', keywords: ['roblox', 'roblox corp'], style: 'growth' },
  'AMZN': { name: 'Amazon.com, Inc.', keywords: ['amazon', 'aws'], style: 'leading' },
  'GOOGL': { name: 'Alphabet Inc.', keywords: ['google', 'alphabet'], style: 'leading' }
};

// --- 유틸리티 함수 ---
const calculateSMA = (data, window) => {
    if (!data || data.length < window) return [];
    let r = [];
    for (let i = 0; i <= data.length - window; i++) {
        let sum = 0;
        for (let j = 0; j < window; j++) sum += data[i + j];
        r.push(sum / window);
    }
    return r;
};
const calculateRSI = (data, period = 14) => {
    if (!data || data.length < period) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
};

// --- 메인 핸들러 ---
module.exports = async (request, response) => {
    // ✨ 전체 로직을 try...catch로 감싸 안정적인 오류 처리를 보장합니다.
    try {
        const pineconeIndex = pinecone.index('news-articles');
        const now = new Date();
        const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30)).toISOString().split('T')[0];

        // 1. 뉴스 기사 벡터 검색
        const themeEmbeddings = await Promise.all(
            Object.values(kInvestmentThemes).map(theme =>
                openai.embeddings.create({ model: 'text-embedding-3-small', input: theme.query, dimensions: 1536 })
            )
        );

        const searchQueries = themeEmbeddings.map(embeddingResponse => embeddingResponse.data[0].embedding);
        const searchResults = await Promise.all(
            searchQueries.map(vector =>
                pineconeIndex.query({
                    vector,
                    topK: 15,
                    filter: { publishedAt: { '$gte': thirtyDaysAgo } },
                    includeMetadata: true
                })
            )
        );

        // 2. 기사 처리 및 집계
        let allFoundArticles = [];
        const themeArticleMap = {};
        searchResults.forEach((result, i) => {
            const themeName = Object.keys(kInvestmentThemes)[i];
            const articles = result.matches.map(match => ({ ...match.metadata, id: match.id }));
            themeArticleMap[themeName] = articles;
            allFoundArticles.push(...articles);
        });
        allFoundArticles = Array.from(new Set(allFoundArticles.map(a => a.id))).map(id => allFoundArticles.find(a => a.id === id));

        const articleTexts = allFoundArticles.map(a => a.title + ': ' + a.description).join(' ');
        const doc = nlp(articleTexts);
        const topThemeName = doc.topics().out('array')[0] || Object.keys(kInvestmentThemes)[0];

        // 3. 주식 데이터 조회
        const stockDataPromises = Object.keys(kTickerInfo).map(ticker =>
            fetch(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${ticker}&outputsize=compact&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`)
                .then(res => res.json())
        );
        const stockDataResults = await Promise.all(stockDataPromises);

        // 4. 최종 데이터 조합
        const recommendations = stockDataResults.map((data, i) => {
            const ticker = Object.keys(kTickerInfo)[i];
            const stockData = data['Time Series (Daily)'];
            if (!stockData) return null;

            const timestamps = Object.keys(stockData).slice(0, 30).reverse();
            const quotes = timestamps.map(t => parseFloat(stockData[t]['4. close']));

            const smaShort = calculateSMA(quotes, 5);
            const smaLong = calculateSMA(quotes, 20);
            const rsi14 = calculateRSI(quotes, 14);
            const chartData = quotes.map((q, i) => ({ x: i, y: q }));
            const smaShortData = smaShort.map((s, i) => ({ x: i, y: s }));
            const smaLongData = smaLong.map((s, i) => ({ x: i, y: s }));

            const companyName = kTickerInfo[ticker]?.name || ticker;
            const searchKeywords = kTickerInfo[ticker]?.keywords || [ticker.toLowerCase()];
            const relevantArticles = allFoundArticles.filter(a =>
                searchKeywords.some(kw => a.title.toLowerCase().includes(kw))
            ).slice(0, 5);

            return {
                ticker,
                companyName,
                latestPrice: quotes.length > 0 ? quotes[quotes.length - 1] : 0,
                chartData,
                timestamps,
                smaShortData,
                smaLongData,
                rsi: rsi14,
                trendingTheme: topThemeName,
                relevantArticles
            };
        }).filter(Boolean);

        response.status(200).json({
            recommendations,
            themes: themeArticleMap
        });

    } catch (error) {
        // ✨ 오류 발생 시 서버 로그에 기록하고, 클라이언트에게는 일반적인 오류 메시지를 보냅니다.
        console.error('Error in proxy function:', error);
        response.status(500).json({
            message: 'Internal Server Error',
            // 개발 환경에서는 디버깅을 위해 아래 error.message를 포함할 수 있습니다.
            // error: error.message
        });
    }
};