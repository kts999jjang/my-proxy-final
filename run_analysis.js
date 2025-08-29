require('dotenv').config();
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

// --- 메인 실행 함수 ---
async function main() {
    console.log("백그라운드 분석 및 데이터 저장을 시작합니다...");

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 14); // 14일치 데이터 기준

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

    for (const themeName of Object.keys(kInvestmentThemes)) {
        console.log(`\n'${themeName}' 테마 분석 중...`);
        const themeData = kInvestmentThemes[themeName];
        if (!themeData) continue;

        // 1. 뉴스 요약 및 Pinecone 검색
        const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(themeData.query)}&topic=business,technology&lang=en&max=50&from=${fromDate.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
        const latestNewsResponse = await fetch(gnewsUrl);
        const latestNews = await latestNewsResponse.json();
        if (!latestNews.articles || latestNews.articles.length === 0) {
            console.log(`  - 뉴스를 찾을 수 없습니다.`);
            continue;
        }
        
        const headlines = latestNews.articles.map(a => a.title).join('\n');
        const prompt = `Summarize the key trend within the '${themeName}' theme from these headlines in one objective sentence:\n\n${headlines}`;
        const result = await geminiModel.generateContent(prompt);
        const themeSentence = result.response.text();
        console.log(`  - 트렌드 요약 완료.`);

        const embeddingResult = await embeddingModel.embedContent(themeSentence);
        const queryVector = embeddingResult.embedding.values;
        
        const queryResult = await index.query({ 
            topK: 200, vector: queryVector, includeMetadata: true,
            filter: { "publishedAt": { "$gte": fromDate.getTime() / 1000 } }
        });
        const allFoundArticles = queryResult.matches.map(match => match.metadata);
        if (allFoundArticles.length === 0) {
            console.log(`  - 관련 기사를 찾을 수 없습니다.`);
            continue;
        }
        console.log(`  - Pinecone에서 ${allFoundArticles.length}개의 관련 기사 발견.`);

        // 2. 종목 점수 계산
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

        if (Object.keys(themeTickerScores).length === 0) {
            console.log(`  - 유효한 주식 티커를 찾을 수 없습니다.`);
            continue;
        }
        console.log(`  - ${Object.keys(themeTickerScores).length}개의 종목 점수 계산 완료.`);

        // 3. 테마별 추천 종목 선정
        const sortedTickers = Object.entries(themeTickerScores).sort(([,a],[,b]) => b-a);
        const leadingStocks = sortedTickers.filter(([t]) => kTickerInfo[t]?.style === 'leading').slice(0, 5).map(([t]) => ({ticker: t, companyName: kTickerInfo[t]?.name || t}));
        const growthStocks = sortedTickers.filter(([t]) => kTickerInfo[t]?.style === 'growth').slice(0, 5).map(([t]) => ({ticker: t, companyName: kTickerInfo[t]?.name || t}));
        
        if (leadingStocks.length > 0 || growthStocks.length > 0) {
            finalResults[themeName] = { leading: leadingStocks, growth: growthStocks };
            console.log(`  - 주도주: ${leadingStocks.length}개, 성장주: ${growthStocks.length}개 선정.`);
        }
    }

    // 4. 최종 결과를 Redis에 저장
    console.log("\n분석 완료. 최종 결과를 Redis에 저장합니다...");
    await redis.set('latest_recommendations', JSON.stringify({ results: finalResults }));
    console.log("✨ Redis 저장 완료! 이제 앱에서 새로운 데이터를 조회할 수 있습니다.");
}

main().catch(console.error);