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

  const action = req.query.action;

  if (action === 'get-items' && req.method === 'GET') {
    const [itemsRaw, paypalId, currency] = await Promise.all([
      redis(['GET', 'upsell:items']),
      redis(['GET', 'upsell:paypal']),
      redis(['GET', 'upsell:currency'])
    ]);
    return res.status(200).json({
      items: itemsRaw ? JSON.parse(itemsRaw) : [],
      paypalClientId: paypalId || '',
      currency: currency || 'USD'
    });
  }

  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });

  if (action === 'save-items' && req.method === 'POST') {
    await redis(['SET', 'upsell:items', JSON.stringify(req.body.items || [])]);
    return res.status(200).json({ success: true });
  }

  if (action === 'save-settings' && req.method === 'POST') {
    const { paypalClientId, currency } = req.body;
    await Promise.all([
      redis(['SET', 'upsell:paypal', paypalClientId || '']),
      redis(['SET', 'upsell:currency', currency || 'USD'])
    ]);
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: '잘못된 action' });
};
