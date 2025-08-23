// api/cron/ingest-news.js
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import fetch from 'node-fetch';

// (이 파일은 ES Module 방식으로 작성되었습니다)

export default async function handler(request, response) {
  // 클라이언트 초기화
  const pinecone = new Pinecone({
    environment: process.env.PINECONE_ENVIRONMENT,
    apiKey: process.env.PINECONE_API_KEY,
  });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const index = pinecone.index('news-index'); // Pinecone에서 만든 인덱스 이름

  // 1. GNews에서 최신 비즈니스 뉴스 가져오기
  const gnewsUrl = `https://gnews.io/api/v4/search?q=market&topic=business&lang=en&max=10&apikey=${process.env.GNEWS_API_KEY}`;
  const newsResponse = await fetch(gnewsUrl);
  const newsData = await newsResponse.json();
  const articles = newsData.articles || [];

  if (articles.length === 0) {
    return response.status(200).send('No new articles found.');
  }

  // 2. 각 기사 제목을 벡터로 변환
  const texts = articles.map(a => a.title);
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });

  // 3. Pinecone에 저장할 데이터 형태로 가공
  const vectors = articles.map((article, i) => ({
    id: article.url, // URL을 고유 ID로 사용
    values: embeddingResponse.data[i].embedding,
    metadata: {
      title: article.title,
      source: article.source.name,
      url: article.url,
      publishedAt: article.publishedAt,
    },
  }));

  // 4. Pinecone에 데이터 저장(Upsert)
  await index.upsert(vectors);

  response.status(200).json({ success: true, ingested: vectors.length });
}