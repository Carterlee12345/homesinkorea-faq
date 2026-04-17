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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: '관리자 권한이 없습니다.' });

  const { email, approved } = req.body;
  if (!email) return res.status(400).json({ error: '이메일이 없습니다.' });

  const raw = await redis(['GET', `user:${email}`]);
  if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

  const user = { ...JSON.parse(raw), approved };
  await redis(['SET', `user:${email}`, JSON.stringify(user)]);

  return res.status(200).json({ success: true });
};
