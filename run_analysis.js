require('dotenv').config();
const fetch = require('node-fetch');
const { Pinecone } = require('@pinecone-database/pinecone');
const { Redis } = require('@upstash/redis');
const nlp = require('compromise');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

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
        // ✨ FIX: Finnhub API가 HTML 오류 페이지를 반환하는 경우를 처리합니다.
        if (!response.headers.get('content-type')?.includes('application/json')) {
            const text = await response.text();
            throw new Error(`Finnhub API returned non-JSON response: ${text.substring(0, 100)}`);
        }
        const data = await response.json();

        // Finnhub는 가장 관련성 높은 결과를 첫 번째로 반환합니다.
        const bestMatch = data?.result?.[0];
        if (bestMatch && !bestMatch.symbol.includes('.')) { // .이 포함된 티커(예: BRK.B)는 제외하여 단순화
            const ticker = bestMatch.symbol;
            const companyName = bestMatch.description || ticker;
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
 * Finnhub API를 사용해 회사의 프로필(산업 분류)을 조회하는 함수
 * @param {string} ticker
 * @returns {Promise<string|null>} 회사의 산업 분류 또는 null
 */
async function getCompanyProfile(ticker) {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.finnhubIndustry || null; // 산업 분류 반환
    } catch (e) {
        console.warn(`  - ${ticker}의 회사 프로필 조회 중 오류: ${e.message}`);
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
 * Finnhub API를 사용해 모든 필요한 재무 지표를 한 번에 조회하는 함수
 * @param {string} ticker - 주식 티커
 * @returns {Promise<object|null>} 재무 지표 객체
 */
async function getFinancialMetrics(ticker) {
    const url = `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${process.env.FINNHUB_API_KEY}`;
    try {
        await sleep(1100); // API 호출 제한 준수
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`  - ${ticker}의 재무 지표 조회 실패: Status ${response.status}`);
            return null;
        }
        const data = await response.json();
        return data?.metric || null;
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

class AIService {
    constructor() {
        this.providers = [];
        if (process.env.GEMINI_API_KEY) {
            this.providers.push({
                name: 'Gemini',
                client: new GoogleGenerativeAI(process.env.GEMINI_API_KEY),
                generate: this.generateWithGemini,
            });
        }
        if (process.env.GROQ_API_KEY) {
            this.providers.push({
                name: 'Groq',
                client: new Groq({ apiKey: process.env.GROQ_API_KEY }),
                generate: this.generateWithGroq,
            });
        }
    }

    async generateWithGemini(client, prompt) {
        const model = client.getGenerativeModel({ model: "gemini-1.5-pro-latest" }, { apiVersion: 'v1' });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    async generateWithGroq(client, prompt) {
        const chatCompletion = await client.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama3-8b-8192',
            temperature: 0.3,
            response_format: { type: "json_object" },
        });
        return chatCompletion.choices[0]?.message?.content || "";
    }

    async generateContent(prompt) {
        if (this.providers.length === 0) {
            throw new Error("사용 가능한 AI 서비스가 없습니다. API 키를 확인하세요.");
        }

        for (const provider of this.providers) {
            try {
                console.log(`  - ${provider.name} API를 사용하여 콘텐츠 생성을 시도합니다...`);
                const result = await provider.generate(provider.client, prompt, provider.requestOptions);
                console.log(`  - ${provider.name} API 호출 성공!`);
                return result;
            } catch (error) {
                // 429 (Too Many Requests) 또는 5xx (Server Error)일 경우 다음 프로바이더로 넘어감
                if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
                    console.warn(`  - ${provider.name} API 오류 발생 (Status: ${error.status}). 다음 API로 넘어갑니다...`);
                    continue;
                }
                // 그 외의 오류는 즉시 throw
                throw error;
            }
        }

        // 모든 프로바이더가 실패했을 경우
        throw new Error("모든 AI 서비스 호출에 실패했습니다. API 할당량 및 상태를 확인하세요.");
    }
}

/**
 * AI 서비스를 사용하여 최신 뉴스 기반으로 동적 투자 테마와 쿼리를 생성합니다.
 * @returns {Promise<Object>} 동적으로 생성된 투자 테마 객체
 */
async function generateDynamicThemes(aiService, pinecone, daysToAnalyze) {
    // ✨ DEBUG: 함수 시작 로그 추가
    console.log("🤖 AI를 사용하여 최신 투자 테마를 동적으로 생성합니다...");
    try {
        // ✨ FIX: Pinecone에서 최신 뉴스 제목을 가져와 트렌드 분석에 사용합니다.
        const index = pinecone.index('gcp-starter-gemini');
        // ✨ FIX: 원본 Date 객체가 변경되지 않도록 날짜 계산 방식을 수정합니다.
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysToAnalyze);
        const startTimestamp = Math.floor(startDate.getTime() / 1000);

        // ✨ DEBUG: Pinecone 쿼리 시작 로그 추가
        // 임의의 벡터로 쿼리하여 최신 기사를 가져옵니다. (필터링이 핵심)
        const queryResult = await index.query({
            topK: 200, // 트렌드 분석을 위해 200개 기사 샘플링
            vector: Array(768).fill(0), // Pinecone 인덱스 차원(768)과 일치시킵니다.
            includeMetadata: true,
            filter: { "publishedAt": { "$gte": startTimestamp } },
        });

        // ✨ DEBUG: Pinecone 쿼리 결과 확인
        console.log(`  - Pinecone에서 ${queryResult.matches.length}개의 뉴스 제목을 가져왔습니다.`);
        const articleTitles = queryResult.matches.map(match => match.metadata.title).join('\n');
        if (!articleTitles) throw new Error("Pinecone에서 분석할 최신 뉴스를 찾지 못했습니다.");

        // 2. Gemini에 테마 및 쿼리 생성 요청
        const prompt = `Based on the following recent news headlines, provide two things in a single JSON object:
1. A "summary" of the overall market trends from these headlines, written in Korean, within 2-3 sentences.
2. A "themes" object containing the top 5 most promising investment themes. For each theme, provide a concise theme name in Korean and a GNews search query in English, structured like '("core technology" OR "synonym") AND (CompanyName OR "Another Company")'.

News Headlines:
${articleTitles}