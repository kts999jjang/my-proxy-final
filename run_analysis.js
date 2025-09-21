require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getTickerForCompanyName(companyName, redis) {
    const cleanedName = companyName.toLowerCase().replace(/\./g, '').replace(/,/g, '').replace(/ inc$/, '').trim();
    const cachedData = await redis.get(cleanedName);
    if (cachedData) {
        try {
            // ✨ FIX: 캐시된 데이터가 JSON 형식인지 확인하고 파싱
            return JSON.parse(cachedData);
        } catch (e) {
            // JSON 파싱에 실패하면 과거 데이터(단순 문자열)로 간주하고, 해당 캐시를 삭제하여 다음 실행 시 갱신되도록 함
            await redis.del(cleanedName);
        }
    }

    // ✨ FIX: Alpha Vantage 대신 Finnhub API로 변경
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) throw new Error('FINNHUB_API_KEY is not set.');

    const url = `https://finnhub.io/api/v1/search?q=${cleanedName}&token=${apiKey}`;
    
    try {
        await sleep(1100); // Finnhub API 호출 제한 준수 (분당 60회)
        const response = await fetch(url);
        const data = await response.json();

        // Finnhub는 가장 관련성 높은 결과를 첫 번째로 반환합니다.
        const bestMatch = data?.result?.[0];
        if (bestMatch && !bestMatch.symbol.includes('.')) { // .이 포함된 티커(예: BRK.B)는 제외하여 단순화
            const ticker = bestMatch.symbol;
            const companyName = bestMatch.description;
            // ✨ FIX: 티커와 회사명을 함께 객체로 캐싱
            const result = { ticker, companyName };
            await redis.set(cleanedName, JSON.stringify(result), { ex: 60 * 60 * 24 * 7 });
            return result;
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
    try {
        const marketCap = await getFinancialsMetric(ticker, 'marketCapitalization');
        return marketCap;
    } catch (e) {
        console.warn(`  - ${ticker}의 시가총액 조회 중 오류: ${e.message}`);
        return null;
    }
}
/**
 * Finnhub API를 사용해 내부자 거래 동향을 조회하는 함수
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
async function getBasicFinancials(ticker) {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100);
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.metric || null;
    } catch (e) {
        console.warn(`  - ${ticker}의 기본 재무 정보 조회 중 오류: ${e.message}`);
        return null;
    }
}

/**
 * Yahoo Finance에서 특정 티커의 현재가를 조회합니다.
 * @param {string} ticker
 * @returns {Promise<number|null>}
 */
async function getCurrentPriceFromYahoo(ticker) {
    if (!ticker) return null;
    try {
        // 1일치 데이터만 요청하여 가장 최신 가격을 가져옵니다.
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1m`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
        if (quotes && quotes.length > 0) {
            return quotes[quotes.length - 1]; // 가장 마지막 가격을 현재가로 사용
        }
        return null;
    } catch (e) {
        console.warn(`  - ${ticker}의 Yahoo Finance 현재가 조회 중 오류: ${e.message}`);
        return null;
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
        if (!response.ok) {
            console.warn(`  - ${ticker}의 애널리스트 평가 조회 실패: Status ${response.status}`);
            return 0;
        }
        const data = (await response.json())?.[0];
        // 'strongBuy'와 'buy'의 합을 점수로 활용
        return (data?.strongBuy || 0) * 2 + (data?.buy || 0);
    } catch (e) {
        console.warn(`  - ${ticker}의 애널리스트 평가 조회 중 오류: ${e.message}`);
        return 0;
    }
}

/**
 * Finnhub API를 사용해 기본 재무 정보를 조회하고 점수를 매기는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number>} 재무 점수
 */
async function getFinancialsScore(ticker) {
    try {
        const pe = await getFinancialsMetric(ticker, 'peNormalizedAnnual');
        const pb = await getFinancialsMetric(ticker, 'pbAnnual');
        let score = 0;

        // P/E 비율이 낮을수록 높은 점수 (30 미만일 때)
        if (pe && pe < 30) {
            score += (1 - pe / 30) * 5;
        }
        // P/B 비율이 낮을수록 높은 점수 (3 미만일 때)
        if (pb && pb < 3) {
            score += (1 - pb / 3) * 5;
        }
        return score;
    } catch (e) {
        console.warn(`  - ${ticker}의 재무 정보 조회 중 오류: ${e.message}`);
        return 0;
    }
}

async function getFinancialsMetric(ticker, metricName) {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.warn(`  - ${ticker}의 재무 정보 API가 유효하지 않은 응답을 반환했습니다.`);
            return null;
        }
        return data?.metric ? data.metric[metricName] : null;
    } catch (e) {
        return null;
    }
}

/**
 * Finnhub API를 사용해 어닝 서프라이즈 정보를 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<number>} 어닝 서프라이즈 점수
 */
async function getEarningsSurpriseScore(ticker) {
    const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`  - ${ticker}의 어닝 서프라이즈 조회 실패: Status ${response.status}`);
            return 0;
        }
        const data = await response.json();
        // 최근 4분기 동안 예상치를 상회한(positive surprise) 횟수를 점수로 활용
        const positiveSurprises = data?.filter(d => d.surprise > 0).length || 0;
        return positiveSurprises * 2.5; // 분기당 2.5점 부여
    } catch (e) {
        console.warn(`  - ${ticker}의 어닝 서프라이즈 조회 중 오류: ${e.message}`);
        return 0;
    }
}

/**
 * GNews 기사를 기반으로 로컬에서 뉴스 감성 점수를 계산하는 함수
 * @param {string} ticker - 주식 티커
 * @param {Array} allArticles - GNews에서 수집된 모든 기사 배열
 * @param {Object} kTickerInfo - 티커 정보 객체
 * @returns {number} 뉴스 감성 점수
 */
function analyzeLocalNewsSentiment(ticker, allArticles, kTickerInfo) {
    const infoString = kTickerInfo[ticker];
    if (!infoString) return 5; // 정보가 없으면 중립 점수

    try {
        const info = JSON.parse(infoString);
        const keywords = info.keywords || [ticker.toLowerCase()];
        const relevantArticles = allArticles.filter(article => 
            keywords.some(kw => article.title.toLowerCase().includes(kw))
        );

        if (relevantArticles.length === 0) return 5; // 관련 기사가 없으면 중립 점수

        const totalSentiment = relevantArticles.reduce((sum, article) => sum + (nlp(article.title).sentiment().score || 0), 0);
        return 5 + (totalSentiment / relevantArticles.length) * 5; // 0-10점 척도로 변환 (기본 5점)
    } catch (e) {
        return 5; // 파싱 실패 시 중립 점수
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

/**
 * Gemini AI를 사용하여 최신 뉴스 기반으로 동적 투자 테마와 쿼리를 생성합니다.
 * @param {GoogleGenerativeAI} genAI - GoogleGenerativeAI 인스턴스
 * @returns {Promise<Object>} 동적으로 생성된 투자 테마 객체
 */
async function generateDynamicThemes(genAI) {
    console.log("🤖 AI를 사용하여 최신 투자 테마를 동적으로 생성합니다...");
    try {
        // 1. 트렌드 파악을 위한 일반 뉴스 수집
        const trendQuery = '"market trend" OR "investment opportunity" OR "technology breakthrough" OR "industry analysis"';
        const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(trendQuery)}&topic=business,technology&lang=en&max=50&apikey=${process.env.GNEWS_API_KEY}`;
        
        // ✨ FIX: 타임아웃 오류에 대비한 재시도 로직 추가
        let response;
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                response = await fetch(gnewsUrl, { timeout: 15000 }); // 15초 타임아웃 설정
                if (response.ok) break;
            } catch (e) {
                console.warn(`  - GNews 트렌드 뉴스 수집 실패 (시도 ${attempts + 1}/${maxAttempts})...`);
                if (attempts + 1 === maxAttempts) throw e; // 마지막 시도에서도 실패하면 오류를 던짐
            }
            attempts++;
            await sleep(2000); // 2초 후 재시도
        }

        const data = await response.json();
        const articleTitles = data.articles?.map(a => a.title).join('\n') || '';

        // 2. Gemini에 테마 및 쿼리 생성 요청
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Based on the following recent news headlines, identify the top 5 most promising investment themes. For each theme, provide a concise theme name in Korean and a GNews search query. The query must be in English and structured like '("core technology" OR "synonym") AND (CompanyName OR "Another Company")'.

News Headlines:
${articleTitles}

Provide the output ONLY in JSON format like this:
{
  "테마 이름 1": { "query": "GNews query for theme 1" },
  "테마 이름 2": { "query": "GNews query for theme 2" }
}`;

        const result = await model.generateContent(prompt);
        const jsonString = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const dynamicThemes = JSON.parse(jsonString);

        console.log("✅ 동적 테마 생성 완료:", Object.keys(dynamicThemes).join(', '));
        return dynamicThemes;

    } catch (error) {
        console.error("동적 테마 생성 중 오류 발생. 기본 테마를 사용합니다.", error);
        // 오류 발생 시 사용할 기본(fallback) 테마
        return {
            '인공지능(AI)': { query: '"artificial intelligence" AND (NVIDIA OR Google)' },
            '전기차 & 배터리': { query: '"electric vehicle" AND (Tesla OR "LG Energy Solution")' },
        };
    }
}

/**
 * ✨ FIX: 동적으로 생성된 테마를 기반으로 GNews에서 기사를 수집하고 Pinecone에 저장합니다.
 * @param {object} themes - 동적으로 생성된 투자 테마 객체
 * @param {Pinecone} pinecone - Pinecone 클라이언트 인스턴스
 * @param {GoogleGenerativeAI} genAI - GoogleGenerativeAI 인스턴스
 */
async function populateNewsForThemes(themes, pinecone, genAI, daysToFetch) { // daysToFetch 인자 추가
    console.log("📰 동적 테마 기반으로 뉴스 수집 및 Pinecone 저장을 시작합니다...");
    const index = pinecone.index('gcp-starter-gemini');
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const BATCH_SIZE = 100;

    let allArticles = [];

    for (const [themeName, themeData] of Object.entries(themes)) {
        try {
            const from = new Date();
            from.setDate(from.getDate() - daysToFetch); // 전달받은 기간 사용
            const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(themeData.query)}&lang=en&max=100&from=${from.toISOString()}&apikey=${process.env.GNEWS_API_KEY}`;
            const response = await fetch(gnewsUrl);
            const data = await response.json();
            if (data.articles) {
                const articlesWithTheme = data.articles.map(article => ({ ...article, theme: themeName }));
                allArticles.push(...articlesWithTheme);
                console.log(`  - '${themeName}' 테마 기사 ${data.articles.length}개 수집 완료.`);
            }
        } catch (e) {
            console.error(`'${themeName}' 테마 기사 수집 중 오류 발생:`, e);
        }
    }

    const uniqueArticles = Array.from(new Map(allArticles.map(article => [article.url, article])).values());
    console.log(`\n총 ${uniqueArticles.length}개의 고유한 기사가 수집되었습니다. Pinecone에 저장합니다...`);

    let vectors = [];
    for (const article of uniqueArticles) {
        try {
            const embeddingResult = await embeddingModel.embedContent(article.title);
            vectors.push({
                id: article.url,
                values: embeddingResult.embedding.values,
                metadata: {
                    title: article.title,
                    source: article.source.name,
                    url: article.url,
                    publishedAt: Math.floor(new Date(article.publishedAt).getTime() / 1000),
                    theme: article.theme,
                },
            });
        } catch (e) {
            console.error(`'${article.title}' 임베딩 변환 중 오류:`, e.message);
        }
    }

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
        const batch = vectors.slice(i, i + BATCH_SIZE);
        await index.upsert(batch);
    }
    console.log("✅ Pinecone에 최신 뉴스 데이터 저장 완료!");
}

// --- 메인 실행 함수 ---
async function main() {
    // ✨ FIX: 커맨드 라인 인자에서 분석 기간을 파싱합니다.
    const args = process.argv.slice(2);
    const periodArg = args.find(arg => arg.startsWith('--period='));
    const periodString = periodArg ? periodArg.split('=')[1] : '14d'; // 기본값 14일
    
    const periodMap = { '7d': 7, '14d': 14, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };
    const daysToAnalyze = periodMap[periodString] || 14;
    const redisKey = `recommendations_${periodString}`; // 기간별 Redis 키 생성
    console.log(`분석 기간: ${daysToAnalyze}일, Redis 저장 키: ${redisKey}`);

    const pinecone = new Pinecone();
    const index = pinecone.index('gcp-starter-gemini');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    await sendSlackNotification("📈 주식 분석 스크립트를 시작합니다...", '#439FE0');

    // ✨ FIX: AI를 사용하여 동적으로 투자 테마를 생성
    const kInvestmentThemes = await generateDynamicThemes(genAI);

    // ✨ FIX: 생성된 동적 테마를 기반으로 뉴스를 수집하고 Pinecone에 저장
    await populateNewsForThemes(kInvestmentThemes, pinecone, genAI, daysToAnalyze); // daysToAnalyze 전달

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
                includeMetadata: true, // ✨ FIX: 날짜 필터를 제거하고 테마 필터만 남김
                filter: { "theme": { "$eq": themeName } },
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

            // ✨ FIX: 모든 기관명에 대해 티커를 조회하고 점수를 집계
            for (const [orgName, count] of Object.entries(organizationCounts)) {
                const companyInfo = await getTickerForCompanyName(orgName, redis);
                if (companyInfo && companyInfo.ticker) {
                    const newTicker = companyInfo.ticker;
                    themeTickerScores[newTicker] = (themeTickerScores[newTicker] || 0) + count;

                    if (!kTickerInfo[newTicker]) {
                        const newInfo = { name: companyInfo.companyName, style: 'growth', keywords: [orgName.toLowerCase()] };
                        kTickerInfo[newTicker] = JSON.stringify(newInfo);
                    }
                }
            }

            // STEP 4: 후보군 선정 (언급 빈도 상위 20개)
            const candidatesForAnalysis = Object.entries(themeTickerScores)
                .sort(([,a],[,b]) => b-a)
                .slice(0, 20) // 언급 빈도 상위 20개 종목만 심층 분석
                .map(([ticker, newsScore]) => ({ ticker, newsScore }));
            
            console.log(`  - 상위 ${candidatesForAnalysis.length}개 후보 종목에 대한 심층 분석을 시작합니다...`);

            // STEP 5: 내부자/애널리스트 점수만 병렬로 조회
            const tickersToAnalyze = candidatesForAnalysis.map(c => c.ticker);
            const analysisPromises = tickersToAnalyze.map(ticker => Promise.all([
                getBasicFinancials(ticker), // ✨ FIX: 시총, 베타 등 핵심 지표를 한 번에 가져옴
                getAnalystRatingScore(ticker),
                getEarningsSurpriseScore(ticker),
                getFinancialsScore(ticker),
                getCurrentPriceFromYahoo(ticker) // ✨ FIX: Yahoo Finance에서 현재가 조회
            ]));
            const analysisResults = await Promise.all(analysisPromises);

            // STEP 6: 최종 점수 계산 및 추천 목록 생성
            const scoredStocks = [];
            for (let i = 0; i < candidatesForAnalysis.length; i++) {
                const { ticker, newsScore } = candidatesForAnalysis[i];
                const [basicFinancials, analystScore, surpriseScore, financialsScore, currentPrice] = analysisResults[i];

                // ✨ FIX: 기본 재무 정보에서 새로운 지표 추출
                const marketCap = basicFinancials?.marketCapitalization || 0;
                
                // '베타' 점수: 1보다 낮을수록 안정적이라고 판단하여 높은 점수 부여 (최대 10점)
                const beta = basicFinancials?.beta || 1.5; // 데이터 없으면 1.5로 간주
                const betaScore = Math.max(0, (1.5 - beta) / 1.5 * 10);

                // '상승 잠재력' 점수: 52주 최고가 대비 현재가가 낮을수록 높은 점수 (최대 10점)
                const high52w = basicFinancials?.['52WeekHigh'];
                const low52w = basicFinancials?.['52WeekLow'];
                const potentialScore = (high52w && currentPrice) ? ((high52w - currentPrice) / (high52w - low52w || 1)) * 10 : 0;

                const sentimentScore = analyzeLocalNewsSentiment(ticker, allFoundArticles, kTickerInfo);

                // ✨ FIX: 점수 체계를 '관심도'와 '펀더멘탈'로 분리
                const hypeScore = (newsScore * 0.6) + (sentimentScore * 0.4); // 관심도 = 언급량 60% + 감성 40%
                const valueScore = (analystScore * 0.3) + (betaScore * 0.2) + (financialsScore * 0.2) + (surpriseScore * 0.15) + (potentialScore * 0.15); // 펀더멘탈 점수 재구성
                
                let compositeScore = (hypeScore * 0.3) + (valueScore * 0.7); // 최종 점수 = 관심도 30% + 펀더멘탈 70%

                // ✨ FIX: 시가총액 기준으로 스타일을 동적으로 결정하고 Redis에 저장
                let existingInfo; // ✨ FIX: existingInfo를 루프 상단에 선언하여 스코프 문제 해결
                let style = 'growth'; // 기본값
                // 시가총액이 낮을수록 보너스 점수 부여 (숨은 보석 찾기)
                if (marketCap) {
                    if (marketCap >= 100000) { // 시가총액 단위가 백만 달러이므로, 1000억 달러 = 100,000 백만 달러
                        style = 'leading';
                    } else {
                        const marketCapBonus = (1 - Math.min(marketCap, 100e9) / 100e9) * 10; // 최대 10점 보너스
                        compositeScore += marketCapBonus;
                    }
                    // Redis에 최신 정보 저장
                    // ✨ FIX: kTickerInfo에서 name을 안전하게 파싱하여 사용
                    const infoValue = kTickerInfo[ticker];
                    if (typeof infoValue === 'string') {
                        try {
                            existingInfo = JSON.parse(infoValue);
                        } catch (e) {
                            console.error(`[DEBUG] Failed to parse kTickerInfo for ${ticker}. Value:`, infoValue);
                            existingInfo = { name: ticker, keywords: [] };
                        }
                    } else {
                        console.error(`[DEBUG] kTickerInfo for ${ticker} is not a string. Value:`, infoValue);
                        existingInfo = { name: ticker, keywords: [] };
                    }
                    const stockInfo = { name: existingInfo.name || ticker, style, keywords: existingInfo.keywords || [] };
                    await redis.hset('stock-info', { [ticker]: JSON.stringify(stockInfo) });
                    // 메모리에 있는 정보도 업데이트
                    kTickerInfo[ticker] = JSON.stringify(stockInfo); // ✨ FIX: 메모리 내 kTickerInfo에도 항상 JSON 문자열을 저장하여 데이터 형식을 일관되게 유지
                }

                // ✨ FIX: 상세 페이지에서 사용할 수 있도록, 추천 근거가 된 뉴스 기사 목록을 찾습니다.
                let relevantArticlesForStock = [];
                if (existingInfo) {
                    // ✨ FIX: keywords가 비어있으면 회사 이름을 기본 키워드로 사용
                    const searchKeywords = (existingInfo.keywords && existingInfo.keywords.length > 0)
                        ? existingInfo.keywords
                        : [existingInfo.name.toLowerCase()];
                    relevantArticlesForStock = allFoundArticles.filter(a => 
                        searchKeywords.some(kw => a.title.toLowerCase().includes(kw))
                    );
                }

                console.log(`  - [${ticker}] 점수: ${compositeScore.toFixed(2)} (뉴스언급: ${newsScore}, 베타: ${betaScore.toFixed(1)}, 애널리스트: ${analystScore}, 서프라이즈: ${surpriseScore}, 재무: ${financialsScore.toFixed(1)}, 감성: ${sentimentScore.toFixed(1)}, 시총: ${marketCap ? (marketCap/1000).toFixed(1)+'B' : 'N/A'})`);
                // ✨ FIX: hypeScore와 valueScore를 scoredStocks 객체에 올바르게 추가
                scoredStocks.push({ 
                    ticker, 
                    score: compositeScore, 
                    companyName: existingInfo?.name || ticker, // ✨ FIX: hypeScore와 valueScore를 reason 객체 안으로 이동
                    reason: {
                        newsScore,
                        insiderScore: betaScore, // '내부자' 항목을 '베타' 점수로 대체
                        analystScore,
                        surpriseScore,
                        financialsScore,
                        sentimentScore,
                        potentialScore, // '상승 잠재력' 점수 추가
                        hypeScore,
                        valueScore,
                    },
                    relevantArticles: relevantArticlesForStock.slice(0, 10)
                });
            }

            // STEP 7: Filter and categorize stocks into 'leading' and 'growth'
            const SCORE_THRESHOLD = 8.0; // 추천 기준 점수
            const finalRecommendations = scoredStocks
                .filter(stock => stock.score > SCORE_THRESHOLD)
                .sort((a, b) => b.score - a.score)
                .slice(0, 10);
            
            if (finalRecommendations.length > 0) {
                const leading = finalRecommendations.filter(s => {
                    try {
                        return JSON.parse(kTickerInfo[s.ticker]).style === 'leading';
                    } catch {
                        return false;
                    }
                });
                const growth = finalRecommendations.filter(s => {
                     try {
                        return JSON.parse(kTickerInfo[s.ticker]).style !== 'leading';
                    } catch {
                        return true;
                    }
                });
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
        await redis.set(redisKey, JSON.stringify({ results: finalResults, analyzedAt: new Date().toISOString() })); // 기간별 키로 저장
        await sendSlackNotification(successMessage, 'good');
    } else {
        const warningMessage = "⚠️ 분석된 유효한 추천 종목이 없어 Redis에 데이터를 저장하지 않았습니다.";
        console.warn(warningMessage);
        await sendSlackNotification(warningMessage, 'warning');
    }
}

main().catch(console.error);