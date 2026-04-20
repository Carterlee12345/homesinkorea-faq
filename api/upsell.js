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
    const [itemsRaw, paypalId, currency, catsRaw] = await Promise.all([
      redis(['GET', 'upsell:items']),
      redis(['GET', 'upsell:paypal']),
      redis(['GET', 'upsell:currency']),
      redis(['GET', 'upsell:categories'])
    ]);
    return res.status(200).json({
      items: itemsRaw ? JSON.parse(itemsRaw) : [],
      paypalClientId: paypalId || '',
      currency: currency || 'USD',
      categories: catsRaw ? JSON.parse(catsRaw) : []
    });
  }

  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!verifyToken(token)) return res.status(401).json({ error: '인증이 필요합니다.' });

  if (action === 'save-items' && req.method === 'POST') {
    await redis(['SET', 'upsell:items', JSON.stringify(req.body.items || [])]);
    return res.status(200).json({ success: true });
  }

  if (action === 'save-settings' && req.method === 'POST') {
    const { paypalClientId, currency, categories, feePct, feeFixed } = req.body;
    await Promise.all([
      redis(['SET', 'upsell:paypal', paypalClientId || '']),
      redis(['SET', 'upsell:currency', currency || 'USD']),
      redis(['SET', 'upsell:categories', JSON.stringify(categories || [])]),
      redis(['SET', 'upsell:fee', JSON.stringify({ pct: feePct ?? 3.49, fixed: feeFixed ?? 0.49 })])
    ]);
    return res.status(200).json({ success: true });
  }

  // ── save-order (public — called from customer-facing shop) ──
  if (action === 'save-order' && req.method === 'POST') {
    const { paypalOrderId, itemId, itemName, amount, currency, customerName, customerWhatsapp } = req.body;
    if (!paypalOrderId || !amount) return res.status(400).json({ error: 'missing fields' });
    const id = `ord_${crypto.randomBytes(5).toString('hex')}`;
    const order = JSON.stringify({
      id, paypalOrderId,
      itemId: itemId || '', itemName: itemName || '',
      amount: parseFloat(amount), currency: currency || 'USD',
      customerName: customerName || '', customerWhatsapp: customerWhatsapp || '',
      paidAt: new Date().toISOString()
    });
    await redis(['LPUSH', 'upsell:orders', order]);
    await redis(['LTRIM', 'upsell:orders', 0, 499]);

    // push purchase notification to all admin users
    const allEmails = await redis(['SMEMBERS', 'users']);
    if (allEmails && allEmails.length) {
      const userRaws = await Promise.all(allEmails.map(e => redis(['GET', `user:${e}`])));
      const admins = userRaws.filter(Boolean).map(r => JSON.parse(r)).filter(u => u.isAdmin && u.approved);
      const notif = JSON.stringify({
        id: `notif_${crypto.randomBytes(5).toString('hex')}`,
        type: 'purchase',
        itemName: itemName || '(아이템 없음)',
        amount: parseFloat(amount),
        currency: currency || 'USD',
        customerName: customerName || '이름 없음',
        customerWhatsapp: customerWhatsapp || '',
        createdAt: new Date().toISOString()
      });
      await Promise.all(admins.map(async u => {
        await redis(['LPUSH', `notifications:${u.email}`, notif]);
        await redis(['LTRIM', `notifications:${u.email}`, '0', '49']);
      }));
    }

    return res.status(200).json({ ok: true, id });
  }

  // ── list-orders (admin auth required) ──
  if (action === 'list-orders' && req.method === 'GET') {
    if (!verifyToken(req.headers['authorization']?.replace('Bearer ', '')))
      return res.status(401).json({ error: '인증 필요' });
    const [raws, feeRaw] = await Promise.all([
      redis(['LRANGE', 'upsell:orders', '0', '199']),
      redis(['GET', 'upsell:fee'])
    ]);
    const orders = (raws || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    const fee = feeRaw ? JSON.parse(feeRaw) : { pct: 3.49, fixed: 0.49 };
    return res.status(200).json({ orders, fee });
  }

  // ── delete-order (admin auth required) ──
  if (action === 'delete-order' && req.method === 'POST') {
    if (!verifyToken(req.headers['authorization']?.replace('Bearer ', '')))
      return res.status(401).json({ error: '인증 필요' });
    const { id } = req.body;
    const raws = await redis(['LRANGE', 'upsell:orders', '0', '499']);
    const kept = (raws || []).filter(r => { try { return JSON.parse(r).id !== id; } catch { return true; } });
    await redis(['DEL', 'upsell:orders']);
    if (kept.length) await redis(['RPUSH', 'upsell:orders', ...kept]);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: '잘못된 action' });
};
