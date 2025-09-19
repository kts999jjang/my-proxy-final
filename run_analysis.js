require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { kInvestmentThemes } = require('./constants');

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
            const companyName = bestMatch['2. name'];
            // ✨ FIX: 티커와 회사명을 함께 객체로 캐싱
            const result = { ticker, companyName };
            await redis.set(cleanedName, JSON.stringify(result), { ex: 60 * 60 * 24 * 7 });
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
 * Finnhub API를 사용해 내부자 거래 동향을 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number>} 내부자 거래 점수
 */
async function getInsiderSentimentScore(ticker) {
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().split('T')[0];
    const url = `https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${ticker}&from=${from}&to=${to}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수 (분당 60회)
        const response = await fetch(url);
        const data = await response.json();
        // 월별 순매수(mspr)가 0보다 큰 달의 수를 점수로 활용 (최근 3개월)
        const positiveMonths = data?.data?.filter(d => d.mspr > 0).length || 0;
        return positiveMonths * 5; // 긍정적인 달 하나당 5점 부여
    } catch (e) {
        console.warn(`  - ${ticker}의 내부자 거래 조회 중 오류: ${e.message}`);
        return 0;
    }
}

/**
 * Finnhub API를 사용해 애널리스트 추천 동향을 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number>} 애널리스트 추천 점수
 */
async function getAnalystRatingScore(ticker) {
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        const data = (await response.json())?.[0];
        // 'strongBuy'와 'buy'의 합을 점수로 활용
        return (data?.strongBuy || 0) * 2 + (data?.buy || 0);
    } catch (e) {
        console.warn(`  - ${ticker}의 애널리스트 평가 조회 중 오류: ${e.message}`);
        return 0;
    }
}

/**
 * Slack으로 알림 메시지를 전송하는 함수
 * @param {string} message - 보낼 메시지
 * @param {'good' | 'danger' | 'warning'} color - 메시지 색상 (good: 초록, danger: 빨강, warning: 노랑)
 */
async function sendSlackNotification(message, color = 'good') {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
        console.log("Slack Webhook URL이 설정되지 않아 알림을 보내지 않습니다.");
        return;
    }

    const payload = {
        attachments: [{
            color: color,
            text: message,
            ts: Math.floor(Date.now() / 1000)
        }]
    };

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error("Slack 알림 전송 중 오류 발생:", error);
    }
}

// --- 메인 실행 함수 ---
async function main() {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 14);

    const pinecone = new Pinecone();
    const index = pinecone.index('gcp-starter-gemini');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    await sendSlackNotification("📈 주식 분석 스크립트를 시작합니다...", '#439FE0');

    // ✨ FIX: Redis에서 모든 주식 정보를 가져와 메모리에 로드
    const kTickerInfo = await redis.hgetall('stock-info') || {};
    console.log(`${Object.keys(kTickerInfo).length}개의 주식 정보를 Redis에서 로드했습니다.`);

    const finalResults = {};

    // ✨ FIX 3: 시가총액 중복 조회를 방지하기 위한 캐시
    const marketCapCache = new Map();

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
                topK: 500, 
                vector: queryVector, 
                includeMetadata: true,
                // ✨ FIX 1: 테마별 뉴스 필터링을 위해 테마 이름을 메타데이터로 활용
                filter: { "theme": { "$eq": themeName } }
            });

            const allFoundArticles = queryResult.matches.map(match => match.metadata);
            if (allFoundArticles.length === 0) {
                console.log(`  - 관련 기사를 찾을 수 없습니다.`);
                continue;
            }
            console.log(`  - Pinecone에서 ${allFoundArticles.length}개의 관련 기사를 분석합니다.`);

            // STEP 1: API 호출 없이 뉴스에서 기관명과 언급 빈도수만 추출
            const organizationCounts = {};
            const BANNED_ORG_NAMES = new Set(['ai', 'inc', 'corp', 'llc', 'ltd', 'group', 'co', 'tech', 'solutions']);

            allFoundArticles.forEach(article => {
                const doc = nlp(article.title);
                doc.organizations().out('array').forEach(org => {
                    const orgName = org.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
                    if (orgName.length > 2 && !BANNED_ORG_NAMES.has(orgName)) {
                        organizationCounts[orgName] = (organizationCounts[orgName] || 0) + 1; // 기본 언급 횟수
                    }
                });
            });

            const themeTickerScores = {};
            const unknownOrgs = [];

            // STEP 2: 추출된 기관명을 kTickerInfo와 매칭하여 티커 찾기
            for (const [orgName, count] of Object.entries(organizationCounts)) {
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

            // ✨ FIX: kTickerInfo에 없는 새로운 회사들도 적극적으로 티커를 조회하고 분석 대상에 포함
            console.log(`  - ${unknownOrgs.length}개의 새로운 회사 티커를 조회합니다...`);
            const unknownOrgsToQuery = unknownOrgs
                .sort((a, b) => organizationCounts[b] - organizationCounts[a])
                .slice(0, 10); // 상위 10개의 새로운 회사에 대해서만 티커 조회 (API 호출 제한)

            for (const orgName of unknownOrgsToQuery) {
                const companyInfo = await getTickerForCompanyName(orgName, redis);
                if (companyInfo && companyInfo.ticker && !kTickerInfo[companyInfo.ticker]) {
                    const newTicker = companyInfo.ticker;
                    themeTickerScores[newTicker] = (themeTickerScores[newTicker] || 0) + organizationCounts[orgName];
                    // ✨ FIX: 새로운 종목 정보를 kTickerInfo에 임시 추가 (분류를 위해)
                    kTickerInfo[newTicker] = { name: companyInfo.companyName, style: 'growth' }; // 기본값은 'growth'
                }
            }

            // STEP 4: 후보군 선정 (언급 빈도 상위 20개)
            const candidatesForAnalysis = Object.entries(themeTickerScores)
                .sort(([,a],[,b]) => b-a)
                .slice(0, 20) // 언급 빈도 상위 20개 종목만 심층 분석
                .map(([ticker, newsScore]) => ({ ticker, newsScore }));
            
            console.log(`  - 상위 ${candidatesForAnalysis.length}개 후보 종목에 대한 심층 분석을 시작합니다...`);

            // ✨ FIX 3: 시가총액을 미리 한 번만 조회하여 캐시에 저장
            for (const candidate of candidatesForAnalysis) {
                if (!marketCapCache.has(candidate.ticker)) {
                    const marketCap = await getMarketCap(candidate.ticker);
                    marketCapCache.set(candidate.ticker, marketCap);
                }
            }

            // STEP 5: 내부자/애널리스트 점수만 병렬로 조회
            const tickersToAnalyze = candidatesForAnalysis.map(c => c.ticker);
            const analysisPromises = tickersToAnalyze.map(ticker => Promise.all([
                getInsiderSentimentScore(ticker),
                getAnalystRatingScore(ticker)
            ]));
            const analysisResults = await Promise.all(analysisPromises);

            // STEP 6: 최종 점수 계산 및 추천 목록 생성
            const scoredStocks = [];
            for (let i = 0; i < candidatesForAnalysis.length; i++) {
                const { ticker, newsScore } = candidatesForAnalysis[i];
                const [insiderScore, analystScore] = analysisResults[i];
                const marketCap = marketCapCache.get(ticker); // 캐시에서 시가총액 조회

                // 각 지표에 가중치를 부여하여 종합 점수 계산
                const weights = { news: 0.2, insider: 0.4, analyst: 0.4 };
                let compositeScore = (newsScore * weights.news) + (insiderScore * weights.insider) + (analystScore * weights.analyst);
                
                // ✨ FIX: 시가총액 기준으로 스타일을 동적으로 결정하고 Redis에 저장
                let style = 'growth'; // 기본값
                // 시가총액이 낮을수록 보너스 점수 부여 (숨은 보석 찾기)
                if (marketCap) {
                    if (marketCap >= 100 * 1000 * 1000 * 1000) { // 1000억 달러 이상
                        style = 'leading';
                    } else {
                        const marketCapBonus = (1 - Math.min(marketCap, 100e9) / 100e9) * 10; // 최대 10점 보너스
                        compositeScore += marketCapBonus;
                    }
                    // Redis에 최신 정보 저장
                    const stockInfo = { name: kTickerInfo[ticker]?.name || ticker, style };
                    await redis.hset('stock-info', { [ticker]: JSON.stringify(stockInfo) });
                }
                kTickerInfo[ticker].style = style; // 메모리에 있는 정보도 업데이트

                console.log(`  - [${ticker}] 점수: ${compositeScore.toFixed(2)} (뉴스: ${newsScore}, 내부자: ${insiderScore}, 애널리스트: ${analystScore}, 시총: ${marketCap ? (marketCap/1e9).toFixed(1)+'B' : 'N/A'})`);
                scoredStocks.push({ 
                    ticker, 
                    score: compositeScore, 
                    companyName: kTickerInfo[ticker]?.name || ticker, // Redis에서 로드된 정보 사용
                    // ✨ FIX 2: 상세 점수를 reason 객체에 포함
                    reason: {
                        newsScore,
                        insiderScore,
                        analystScore,
                    }
                });
            }

            // STEP 7: Filter and categorize stocks into 'leading' and 'growth'
            const SCORE_THRESHOLD = 8.0; // 추천 기준 점수
            const finalRecommendations = scoredStocks
                .filter(stock => stock.score > SCORE_THRESHOLD)
                .sort((a, b) => b.score - a.score)
                .slice(0, 10);
            
            if (finalRecommendations.length > 0) {
                const leading = finalRecommendations.filter(s => kTickerInfo[s.ticker]?.style === 'leading');
                const growth = finalRecommendations.filter(s => kTickerInfo[s.ticker]?.style !== 'leading');
                finalResults[themeName] = { leading, growth };
                console.log(`  - ${finalRecommendations.length}개의 추천 종목 선정 완료 (주도주: ${leading.length}, 성장주: ${growth.length}).`);
            }
        }
    } catch (error) {
        const errorMessage = `🚨 스크립트 실행 중 치명적인 오류 발생: ${error.message}`;
        console.error(errorMessage);
        await sendSlackNotification(errorMessage, 'danger');
        // 오류 발생 시 프로세스 종료
        process.exit(1);
    }

    // 4. 최종 결과를 Redis에 저장
    if (Object.keys(finalResults).length > 0) {
        const summary = Object.entries(finalResults)
            .map(([theme, res]) => `• *${theme}*: ${res.leading.length + res.growth.length}개`)
            .join('\n');
        const successMessage = `✅ 분석 완료! 총 ${Object.keys(finalResults).length}개 테마의 추천 종목을 Redis에 저장했습니다.\n\n${summary}`;
        console.log(successMessage);
        await redis.set('latest_recommendations', JSON.stringify({ results: finalResults }));
        await sendSlackNotification(successMessage, 'good');
    } else {
        const warningMessage = "⚠️ 분석된 유효한 추천 종목이 없어 Redis에 데이터를 저장하지 않았습니다.";
        console.warn(warningMessage);
        await sendSlackNotification(warningMessage, 'warning');
    }
}

main().catch(console.error);