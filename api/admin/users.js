async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: '관리자 권한이 없습니다.' });

  const emails = await redis(['SMEMBERS', 'users']) || [];
  const users = (await Promise.all(emails.map(async e => {
    const raw = await redis(['GET', `user:${e}`]);
    return raw ? JSON.parse(raw) : null;
  }))).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.status(200).json({ users });
};
