const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const parts = token.split('.');
  if (parts.length !== 3) return res.status(401).json({ error: 'Invalid token' });

  const [payload, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}.${ts}`).digest('hex');
  if (sig !== expected) return res.status(401).json({ error: 'Invalid token' });
  if (Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return res.status(401).json({ error: 'Token expired' });

  return res.status(200).json({ email: Buffer.from(payload, 'base64').toString() });
};
