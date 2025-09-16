require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { kInvestmentThemes, kTickerInfo } = require('./constants');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getTickerForCompanyName(companyName, redis) {
    const cleanedName = companyName.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
    const cachedTicker = await redis.get(cleanedName);
    if (cachedTicker) { return cachedTicker; }

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not set.');

    const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${cleanedName}&apikey=${apiKey}`;
    
    try {
        await sleep(15000); // Alpha Vantage API는 분당 5회 호출 제한이 있으므로 15초 대기
        const response = await fetch(url);
        const data = await response.json();

        if (data.Note) {
            console.warn(`Alpha Vantage API limit likely reached for "${cleanedName}". Note: ${data.Note}`);
            return null;
        }

        const bestMatch = data?.bestMatches?.[0];
        if (bestMatch && parseFloat(bestMatch['9. matchScore']) > 0.7) {
            const ticker = bestMatch['1. symbol'];
            await redis.set(cleanedName, ticker, { ex: 60 * 60 * 24 * 7 });
            return ticker;
        }
        return null;
    } catch (e) {
        console.error(`Error fetching ticker for "${cleanedName}". Reason: ${e.message}`);
        return null;
    }
}

/**
 * Alpha Vantage API를 사용해 시가총액을 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number|null>} 시가총액 또는 null
 */
async function getMarketCap(ticker) {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) return null;
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${apiKey}`;
    try {
        await sleep(15000); // API 호출 제한 준수
        const response = await fetch(url);
        const data = await response.json();
        const marketCap = data?.MarketCapitalization ? parseInt(data.MarketCapitalization, 10) : null;
        return marketCap;
    } catch (e) {
        console.warn(`  - ${ticker}의 시가총액 조회 중 오류: ${e.message}`);
        return null;
    }
}
/**
 * 기사 제목의 감성을 분석하여 점수를 반환하는 함수
 * @param {object} model - Gemini 모델 인스턴스
 * @param {string} title - 분석할 기사 제목
 * @returns {Promise<number>} 감성 점수 (긍정: 1.5, 중립: 1.0, 부정: 0.2)
 */
async function calculateSentimentScore(model, title) {
    try {
        const prompt = `Analyze the sentiment of the following news headline. Respond with only one word: POSITIVE, NEUTRAL, or NEGATIVE.\n\nHeadline: "${title}"`;
        const result = await model.generateContent(prompt);
        const sentiment = result.response.text().trim().toUpperCase();

        if (sentiment.includes('POSITIVE')) return 1.5;
        if (sentiment.includes('NEGATIVE')) return 0.2; // 부정적일 경우 점수를 매우 낮게 부여
        return 1.0; // 중립적이거나 판단이 어려울 경우 기본 점수
    } catch (e) {
        console.warn(`  - 감성 분석 중 오류 발생: ${e.message}. 기본 점수(1.0)를 사용합니다.`);
        // API 오류 발생 시 분석 흐름이 끊기지 않도록 기본 점수 반환
        return 1.0;
    }
}


// --- 메인 실행 함수 ---
async function main() {
    console.log("백그라운드 분석 및 데이터 저장을 시작합니다...");

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 14);

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
        
        let themeSentence;
        let retries = 3;
        while (retries > 0) {
            try {
                const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(themeData.query)}&topic=business,technology&lang=en&max=50&from=${fromDate.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
                const latestNewsResponse = await fetch(gnewsUrl);
                const latestNews = await latestNewsResponse.json();
                if (!latestNews.articles || latestNews.articles.length === 0) {
                    console.log(`  - 뉴스를 찾을 수 없습니다.`);
                    themeSentence = null;
                    break; 
                }
                
                const headlines = latestNews.articles.map(a => a.title).join('\n');
                const prompt = `Summarize the key trend within the '${themeName}' theme from these headlines in one objective sentence:\n\n${headlines}`;
                const result = await geminiModel.generateContent(prompt);
                themeSentence = result.response.text();
                console.log(`  - 트렌드 요약 완료.`);
                break;
            } catch (e) {
                retries--;
                console.warn(`  - Gemini 요약 API 오류 발생. ${retries > 0 ? `${retries}번 더 재시도합니다...` : '재시도 모두 실패.'} (오류: ${e.message})`);
                if (retries === 0) {
                    themeSentence = null;
                }
                await sleep(5000);
            }
        }

        if (!themeSentence) continue;

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
        const orgToArticlesMap = new Map(); // ✨ FIX: 기관별 기사 및 감성점수 매핑
        // 'ai', 'inc' 등 회사 이름으로 잘못 인식될 수 있는 일반 단어 목록
        const BANNED_ORG_NAMES = new Set(['ai', 'inc', 'corp', 'llc', 'ltd', 'group', 'co', 'tech', 'solutions']);

        for (const article of allFoundArticles) {
            const sentimentScore = await calculateSentimentScore(geminiModel, article.title);
            const doc = nlp(article.title);
            doc.organizations().out('array').forEach(org => {
                const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
                // 길이가 1~2자인 약어이거나, 일반 단어 목록에 포함되지 않은 경우에만 점수 계산
                if (orgName.length > 2 && !BANNED_ORG_NAMES.has(orgName)) {
                    organizationCounts[orgName] = (organizationCounts[orgName] || 0) + sentimentScore;
                    if (!orgToArticlesMap.has(orgName)) orgToArticlesMap.set(orgName, []);
                    orgToArticlesMap.get(orgName).push({ title: article.title, sentiment: sentimentScore });
                }
            });
        }

        const themeTickerScores = {};
        const unknownOrgs = [];

        // 1. kTickerInfo에 정의된 종목인지 먼저 확인
        for (const [orgName, count] of Object.entries(organizationCounts)) {
            // kTickerInfo의 keywords와 매칭되는지 명시적으로 확인
            let foundTicker = null;
            for (const [ticker, info] of Object.entries(kTickerInfo)) {
                if (info.keywords.some(kw => orgName.toLowerCase().includes(kw))) {
                    foundTicker = ticker;
                    break;
                }
            }

            if (foundTicker) {
                themeTickerScores[foundTicker] = (themeTickerScores[foundTicker] || 0) + count;
            } else {
                unknownOrgs.push(orgName);
            }
        }

        // 2. kTickerInfo에 없는 회사들만 API로 조회 (API 호출 최소화를 위해 상위 5개만)
        console.log(`  - ${unknownOrgs.length}개의 새로운 회사 티커를 조회합니다...`);
        const topUnknownOrgs = unknownOrgs.sort((a, b) => organizationCounts[b] - organizationCounts[a]).slice(0, 5);
        for (const orgName of topUnknownOrgs) {
            if (!Object.values(kTickerInfo).some(info => info.keywords.some(kw => orgName.includes(kw)))) {
                const newTicker = await getTickerForCompanyName(orgName, redis);
                if (newTicker) {
                    themeTickerScores[newTicker] = (themeTickerScores[newTicker] || 0) + organizationCounts[orgName];
                }
            }
        }

        // 2.5. 시가총액 및 감성 점수를 이용한 최종 점수 보정
        const finalScores = {};
        for (const [ticker, baseScore] of Object.entries(themeTickerScores)) {
            const marketCap = await getMarketCap(ticker);
            let score = parseFloat(baseScore);

            // 시가총액 가중치: 작을수록 높은 보너스 (최대 50%)
            if (marketCap && marketCap < 500 * 1000 * 1000 * 1000) { // 5000억 달러 미만
                const marketCapBonus = 1 + (1 - Math.min(marketCap, 500e9) / 500e9) * 0.5;
                score *= marketCapBonus;
            }

            // ✨ FIX: 올바른 감성 점수 가중치 계산
            const companyKeywords = kTickerInfo[ticker]?.keywords || [ticker.toLowerCase()];
            let totalSentiment = 0;
            let articleCount = 0;
            for (const [orgName, articles] of orgToArticlesMap.entries()) {
                if (companyKeywords.some(kw => orgName.includes(kw))) {
                    articles.forEach(article => { totalSentiment += article.sentiment; articleCount++; });
                }
            }
            const avgSentiment = articleCount > 0 ? totalSentiment / articleCount : 1.0;
            score *= avgSentiment; // 평균 감성 점수를 곱함

            finalScores[ticker] = score;
            console.log(`  - [${ticker}] 최종 점수: ${score.toFixed(2)} (기본: ${baseScore.toFixed(2)}, 시총: ${marketCap ? (marketCap/1e9).toFixed(1)+'B' : 'N/A'}, 감성: ${avgSentiment.toFixed(2)})`);
        }

        if (Object.keys(finalScores).length === 0) {
            console.log(`  - 유효한 주식 티커를 찾을 수 없습니다.`);
            continue;
        }
        console.log(`  - ${Object.keys(finalScores).length}개의 종목 점수 계산 완료.`);

        // 3. 테마별 추천 종목 선정
        const sortedTickers = Object.entries(finalScores).sort(([,a],[,b]) => b-a);
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