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

module.exports = {
    kInvestmentThemes,
    kTickerInfo,
};