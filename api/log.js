const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

function verifyToken(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [payload, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  if (sig !== expected) return null;
  if (Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return null;
  return Buffer.from(payload, 'base64').toString();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const email = verifyToken(token);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const { action, detail } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });

  const entry = JSON.stringify({ email, action, detail: detail || '', ts: new Date().toISOString() });
  await redis(['LPUSH', 'logs:all', entry]);
  await redis(['LPUSH', `logs:${email}`, entry]);
  await redis(['LTRIM', 'logs:all', 0, 999]);
  await redis(['LTRIM', `logs:${email}`, 0, 199]);

  return res.status(200).json({ ok: true });
};
