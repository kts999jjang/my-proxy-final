// api/cron/ingest-news.js
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import fetch from 'node-fetch';

export default async function handler(request, response) {
  // 클라이언트 초기화
  const pinecone = new Pinecone({
    environment: process.env.PINECONE_ENVIRONMENT,
    apiKey: process.env.PINECONE_API_KEY,
  });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const index = pinecone.index('news-index'); 

  // 1. GNews에서 최신 비즈니스/기술 뉴스 가져오기
  const gnewsUrl = `https://gnews.io/api/v4/search?q=market OR economy OR business OR technology&topic=business,technology&lang=en&max=50&apikey=${process.env.GNEWS_API_KEY}`;
  const newsResponse = await fetch(gnewsUrl);
  const newsData = await newsResponse.json();
  const articles = newsData.articles || [];

  if (articles.length === 0) {
    return response.status(200).send('No new articles found.');
  }

  // 2. 각 기사 제목을 벡터로 변환 (중복 방지)
  const textsToEmbed = [];
  const vectorsToUpsert = [];
  const existingIds = new Set((await index.query({ topK: 10000, idOnly: true })).matches.map(m => m.id));

  for (const article of articles) {
    if (!existingIds.has(article.url)) {
      textsToEmbed.push(article.title);
      vectorsToUpsert.push({
        id: article.url,
        metadata: {
          title: article.title,
          source: article.source.name,
          url: article.url,
          publishedAt: article.publishedAt,
        },
      });
    }
  }
  
  if (textsToEmbed.length === 0) {
    return response.status(200).send('No new, unique articles to ingest.');
  }

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: textsToEmbed,
  });

  embeddingResponse.data.forEach((embedding, i) => {
    vectorsToUpsert[i].values = embedding.embedding;
  });

  // 4. Pinecone에 데이터 저장(Upsert)
  await index.upsert(vectorsToUpsert);

  response.status(200).json({ success: true, ingested: vectorsToUpsert.length });
}