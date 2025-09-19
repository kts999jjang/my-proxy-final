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
    // 재시도 로직은 이제 호출하는 쪽에서 중앙 관리합니다.
    try {
        const prompt = `Analyze the sentiment of the following news headline. Respond with only one word: POSITIVE, NEUTRAL, or NEGATIVE.\n\nHeadline: "${title}"`;
        const result = await model.generateContent(prompt);
        const sentiment = result.response.text().trim().toUpperCase();

        if (sentiment.includes('POSITIVE')) return 1.5;
        if (sentiment.includes('NEGATIVE')) return 0.2;
        return 1.0;
    } catch (error) {
        // 배치 프로세서에서 오류를 처리할 수 있도록 오류를 던집니다.
        throw error;
    }
}

/**
 * 데이터에 기반하여 주식 추천 이유를 생성하는 함수
 * @param {object} model - Gemini 모델 인스턴스
 * @param {string} ticker - 주식 티커
 * @param {string} companyName - 회사 이름
 * @param {number} score - 최종 계산 점수
 * @param {number|null} marketCap - 시가총액
 * @param {number} avgSentiment - 평균 뉴스 감성 점수
 * @returns {Promise<string>} 간결한 추천 이유 문장
 */
async function generateRecommendationReason(model, ticker, companyName, score, marketCap, avgSentiment) {
    // Rate-limit을 위해 이 함수 내에서는 sleep을 사용하지 않습니다. 호출하는 쪽에서 제어합니다.
    const prompt = `In one short sentence, explain why ${companyName} (${ticker}) is a noteworthy stock to watch. Base the reason on the following data: a high recommendation score of ${score.toFixed(2)}, an average news sentiment score of ${avgSentiment.toFixed(2)} (where >1.0 is positive), and a market cap of ${marketCap ? `$${(marketCap / 1e9).toFixed(1)} billion` : 'N/A'}. Focus on the positive sentiment and its potential as a smaller-cap company if applicable.`;
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}


// --- 메인 실행 함수 ---
async function main() {
    console.log("백그라운드 분석 및 데이터 저장을 시작합니다...");
    // ✨ FIX: API 호출 횟수를 추적하고 관리하기 위한 카운터
    let geminiApiCallCount = 0;
    const GEMINI_DAILY_LIMIT = 45; // 안전 마진을 둔 일일 API 호출 제한

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

    // ✨ FIX: 스크립트가 비정상 종료되지 않도록 전체를 try...catch로 감쌈
    try {
        for (const themeName of Object.keys(kInvestmentThemes)) {
            console.log(`\n'${themeName}' 테마 분석 중...`);
            const themeData = kInvestmentThemes[themeName];
            if (!themeData) continue;

            // 1. 테마 쿼리 자체를 직접 임베딩하여 관련 기사 검색 (요약 단계 삭제)
            console.log(`  - '${themeName}' 테마 쿼리를 임베딩하여 관련 기사를 검색합니다.`);
            const embeddingResult = await embeddingModel.embedContent({
                content: { parts: [{ text: themeData.query }] },
                taskType: "RETRIEVAL_QUERY",
            });
            const queryVector = embeddingResult.embedding.values;

            // 분석할 기사 수를 500개로 늘림
            const queryResult = await index.query({ 
                topK: 500, vector: queryVector, includeMetadata: true,
                filter: { "publishedAt": { "$gte": fromDate.getTime() / 1000 } }
            });

            const allFoundArticles = queryResult.matches.map(match => match.metadata);
            if (allFoundArticles.length === 0) {
                console.log(`  - 관련 기사를 찾을 수 없습니다.`);
                continue;
            }
            console.log(`  - Pinecone에서 ${allFoundArticles.length}개의 관련 기사를 분석합니다.`);

            // 2. 종목 점수 계산
            const organizationCounts = {};
            const orgToArticlesMap = new Map(); // ✨ FIX: 기관별 기사 및 감성점수 매핑
            // 'ai', 'inc' 등 회사 이름으로 잘못 인식될 수 있는 일반 단어 목록
            const BANNED_ORG_NAMES = new Set(['ai', 'inc', 'corp', 'llc', 'ltd', 'group', 'co', 'tech', 'solutions']);

            // STEP 1: Identify all mentioned organizations and their base scores without API calls
            allFoundArticles.forEach(article => {
                const doc = nlp(article.title);
                doc.organizations().out('array').forEach(org => {
                    const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
                    // 길이가 1~2자인 약어이거나, 일반 단어 목록에 포함되지 않은 경우에만 점수 계산
                    if (orgName.length > 2 && !BANNED_ORG_NAMES.has(orgName)) {
                        organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1; // 기본 언급 횟수
                        if (!orgToArticlesMap.has(orgName)) orgToArticlesMap.set(orgName, { articles: [] });
                        // Store articles for later sentiment analysis
                        orgToArticlesMap.get(orgName).articles = (orgToArticlesMap.get(orgName).articles || []).concat(article.title);
                    }
                });
            });

            const themeTickerScores = {};
            const unknownOrgs = [];

            // STEP 2: Match organizations to known tickers
            for (const [orgName, count] of Object.entries(organizationCounts)) {
                // kTickerInfo의 keywords와 매칭되는지 명시적으로 확인
                let foundTicker = null;
                for (const [ticker, info] of Object.entries(kTickerInfo)) {
                    if (info.keywords.some(kw => orgName.includes(kw))) {
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

            // STEP 3: Find tickers for top unknown organizations (minimal API calls)
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

            // STEP 4: Select top candidates for deep analysis to conserve API quota
            const topCandidates = Object.entries(themeTickerScores)
                .sort(([,a],[,b]) => b-a)
                .slice(0, 15) // Analyze only the top 15 most mentioned stocks
                .map(([ticker, baseScore]) => ({ ticker, baseScore }));

            console.log(`  - 상위 ${topCandidates.length}개 후보 종목에 대한 심층 분석(API 호출)을 시작합니다...`);

            // STEP 5: Perform expensive API calls ONLY for top candidates
            const tickersToAnalyze = topCandidates.map(c => c.ticker);
            const marketCapPromises = tickersToAnalyze.map(ticker => getMarketCap(ticker));
            const marketCaps = await Promise.all(marketCapPromises);

            const scoredStocks = [];
            for (let i = 0; i < topCandidates.length; i++) {
                if (geminiApiCallCount >= GEMINI_DAILY_LIMIT) {
                    console.warn('일일 Gemini API 호출 한도에 도달하여 감성 분석을 중단합니다.');
                    break;
                }

                const { ticker, baseScore } = topCandidates[i];
                const marketCap = marketCaps[i];

                // Calculate sentiment only for this candidate's articles
                const companyKeywords = kTickerInfo[ticker]?.keywords || [ticker.toLowerCase()];
                let articlesForSentiment = [];
                for (const [orgName, data] of orgToArticlesMap.entries()) {
                    if (companyKeywords.some(kw => orgName.includes(kw))) {
                        articlesForSentiment.push(...data.articles);
                    }
                }
                // To save API calls, analyze a max of 5 articles per stock
                const articlesToAnalyze = [...new Set(articlesForSentiment)].slice(0, 5);
                let totalSentiment = 0;
                if (articlesToAnalyze.length > 0) {
                    const sentimentPromises = articlesToAnalyze.map(title => {
                        geminiApiCallCount++;
                        return calculateSentimentScore(geminiModel, title);
                    });
                    const sentimentResults = await Promise.all(sentimentPromises);
                    totalSentiment = sentimentResults.reduce((sum, score) => sum + score, 0);
                }
                const avgSentiment = articlesToAnalyze.length > 0 ? totalSentiment / articlesToAnalyze.length : 1.0;

                let score = parseFloat(baseScore);

                // 시가총액 가중치: 작을수록 높은 보너스 (최대 50%)
                if (marketCap && marketCap < 500 * 1000 * 1000 * 1000) { // 5000억 달러 미만
                    const marketCapBonus = 1 + (1 - Math.min(marketCap, 500e9) / 500e9) * 0.5;
                    score *= marketCapBonus;
                }
                
                score *= avgSentiment; // 평균 감성 점수를 곱함

                console.log(`  - [${ticker}] 점수 계산 완료: ${score.toFixed(2)} (기본: ${baseScore}, 시총: ${marketCap ? (marketCap/1e9).toFixed(1)+'B' : 'N/A'}, 감성: ${avgSentiment.toFixed(2)})`);
                
                scoredStocks.push({ ticker, score, companyName: kTickerInfo[ticker]?.name || ticker, marketCap, avgSentiment });
            }

            if (scoredStocks.length === 0) {
                console.log(`  - 유효한 주식 티커를 찾을 수 없습니다.`);
                continue;
            }
            console.log(`  - ${scoredStocks.length}개의 종목 점수 계산 완료.`);

            // STEP 6: Generate recommendations and reasons
            const SCORE_THRESHOLD = 5.0; // 이 점수 이상일 때만 추천
            const candidates = scoredStocks
                .filter(stock => stock.score > SCORE_THRESHOLD)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5); // 추천 이유 생성을 위해 API 호출 수를 5개로 제한

            let reasons = [];
            if (candidates.length > 0 && geminiApiCallCount < GEMINI_DAILY_LIMIT) {
                console.log(`  - ${candidates.length}개 추천 종목의 추천 이유를 생성합니다...`);
                const reasonPromises = candidates.map(stock => {
                    if (geminiApiCallCount >= GEMINI_DAILY_LIMIT) return "API 호출 한도 도달";
                    geminiApiCallCount++;
                    return generateRecommendationReason(geminiModel, stock.ticker, stock.companyName, stock.score, stock.marketCap, stock.avgSentiment);
                });
                const resolvedReasons = await Promise.all(reasonPromises);
                reasons.push(...resolvedReasons);
            }


            const recommendedStocks = candidates.map((stock, index) => ({
                ticker: stock.ticker,
                companyName: stock.companyName,
                reason: reasons[index] || `뉴스 분석 결과 높은 점수(${stock.score.toFixed(2)})를 기록했습니다.`,
                score: stock.score.toFixed(2)
            }));
            
            if (recommendedStocks.length > 0) {
                finalResults[themeName] = { recommendations: recommendedStocks }; // 새로운 추천 포맷
                console.log(`  - ${recommendedStocks.length}개의 추천 종목 선정 완료.`);
            }
        }
    } catch (error) {
        console.error("스크립트 실행 중 치명적인 오류 발생:", error);
        if (error.message.includes('429')) {
            console.error("오류 원인: API 일일 사용량(쿼터)을 초과했습니다. 스크립트를 중단합니다.");
        }
    }

    // 4. 최종 결과를 Redis에 저장
    console.log("\n분석 완료. 최종 결과를 Redis에 저장합니다...");
    await redis.set('latest_recommendations', JSON.stringify({ results: finalResults }));
    console.log("✨ Redis 저장 완료! 이제 앱에서 새로운 데이터를 조회할 수 있습니다.");
}

main();