const kInvestmentThemes = {
    '인공지능(AI)': { query: '"artificial intelligence" OR "semiconductor" OR "machine learning" OR "NVIDIA"', },
    '메타버스 & VR': { query: '"metaverse" OR "virtual reality" OR "augmented reality" OR "Roblox" OR "Unity"', },
    '전기차 & 자율주행': { query: '"electric vehicle" OR "self-driving" OR "autonomous car" OR "Tesla" OR "Rivian"', },
    '클라우드 컴퓨팅': { query: '"cloud computing" OR "data center" OR "SaaS" OR "Amazon AWS" OR "Microsoft Azure"', },
    '바이오/헬스케어': { query: '"biotechnology" OR "healthcare" OR "pharmaceutical" OR "clinical trial"', },
    '엔터테인먼트/미디어': { query: '"entertainment" OR "streaming" OR "media" OR "Disney" OR "Netflix"', },
    '친환경/에너지': { query: '"renewable energy" OR "solar power" OR "wind power" OR "clean energy"', },
};

module.exports = {
    kInvestmentThemes,
};