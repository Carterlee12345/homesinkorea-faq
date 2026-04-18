const crypto = require('crypto');

async function redis(cmd) {
  const res = await fetch(process.env.UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await res.json()).result;
}

async function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  if (sig !== expected || Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return null;
  return Buffer.from(payload, 'base64').toString();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!await verifyToken(userToken)) return res.status(401).json({ error: '인증이 필요합니다.' });

  if (req.method === 'GET') {
    const raw = await redis(['GET', 'cleaning:data']) || '{}';
    return res.status(200).json(JSON.parse(raw));
  }

  if (req.method === 'POST') {
    const { reservationId, status, cleaningDate, cost, cleaner } = req.body;
    if (!reservationId) return res.status(400).json({ error: 'reservationId 필요' });

    const raw = await redis(['GET', 'cleaning:data']) || '{}';
    const data = JSON.parse(raw);

    data[reservationId] = {
      ...data[reservationId],
      ...(status !== undefined && { status }),
      ...(cleaningDate !== undefined && { cleaningDate }),
      ...(cost !== undefined && { cost }),
      ...(cleaner !== undefined && { cleaner }),
      updatedAt: new Date().toISOString()
    };

    await redis(['SET', 'cleaning:data', JSON.stringify(data)]);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
