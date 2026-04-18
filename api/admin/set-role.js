const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

async function checkAdminAuth(key) {
  if (key === process.env.ADMIN_PASSWORD) return true;
  if (!key?.startsWith('bearer:')) return false;
  const token = key.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [payload, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  if (sig !== expected || Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return false;
  const email = Buffer.from(payload, 'base64').toString();
  const raw = await redis(['GET', `user:${email}`]);
  if (!raw) return false;
  return JSON.parse(raw).isAdmin === true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!await checkAdminAuth(req.headers['x-admin-key']))
    return res.status(401).json({ error: '관리자 권한이 없습니다.' });

  const { email, isAdmin } = req.body;
  if (!email) return res.status(400).json({ error: '이메일이 없습니다.' });

  const raw = await redis(['GET', `user:${email}`]);
  if (!raw) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });

  const user = { ...JSON.parse(raw), isAdmin: !!isAdmin };
  await redis(['SET', `user:${email}`, JSON.stringify(user)]);

  return res.status(200).json({ success: true });
};
