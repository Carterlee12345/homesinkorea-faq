const crypto = require('crypto');

const HA_BASE = 'https://api.hostaway.com/v1';

async function getHAToken() {
  const res = await fetch(`${HA_BASE}/accessTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.HOSTAWAY_ACCOUNT_ID,
      client_secret: process.env.HOSTAWAY_API_SECRET,
      scope: 'general'
    })
  });
  const data = await res.json();
  return data.access_token;
}

async function haFetch(path, token) {
  const res = await fetch(`${HA_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Cache-control': 'no-cache' }
  });
  if (!res.ok) throw new Error(`Hostaway ${path} → HTTP ${res.status}`);
  return res.json();
}

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

  const userToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!verifyToken(userToken)) return res.status(401).json({ error: '인증이 필요합니다.' });

  const resource = req.query.resource;

  // ── reservations ──
  if (resource === 'reservations' && req.method === 'GET') {
    try {
      const haToken = await getHAToken();
      const today = new Date().toISOString().split('T')[0];

      const [activeData, listingsData, stayingData] = await Promise.all([
        haFetch(`/reservations?arrivalStartDate=${today}&limit=200`, haToken),
        haFetch(`/listings?limit=500`, haToken),
        haFetch(`/reservations?arrivalEndDate=${today}&departureDateStart=${today}&limit=200`, haToken)
      ]);

      const listingMap = {};
      (listingsData.result || []).forEach(l => {
        listingMap[l.id] = {
          name: l.externalListingName || l.name || '',
          bedrooms: l.bedroomsNumber || 0,
          bathrooms: l.bathroomsNumber || 0,
          address: l.publicAddress || l.address || ''
        };
      });

      const seen = new Set();
      const reservations = [...(stayingData.result || []), ...(activeData.result || [])]
        .filter(r => {
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          const dep = r.departureDate?.split('T')[0] || '';
          return dep >= today; // 체크아웃이 오늘 이후인 것만
        })
        .map(r => {
          const listing = listingMap[r.listingMapId] || {}; // listingId → listingMapId
          const arr = r.arrivalDate?.split('T')[0] || '';
          const dep = r.departureDate?.split('T')[0] || '';
          const isStaying = arr <= today && dep > today;
          return {
            id: r.id, listingId: r.listingMapId,
            listingName: listing.name, bedrooms: listing.bedrooms,
            bathrooms: listing.bathrooms, address: listing.address,
            arrivalDate: arr, departureDate: dep,
            guestName: r.guestName || '', isStaying
          };
        });

      return res.status(200).json({ reservations });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── debug: see raw listing fields ──
  if (resource === 'debug' && req.method === 'GET') {
    try {
      const haToken = await getHAToken();
      const listingsData = await haFetch(`/listings?limit=3`, haToken);
      return res.status(200).json({ sample: (listingsData.result || []).map(l => Object.keys(l).reduce((o, k) => { o[k] = l[k]; return o; }, {})) });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // ── cleaning GET ──
  if (resource === 'cleaning' && req.method === 'GET') {
    const raw = await redis(['GET', 'cleaning:data']) || '{}';
    return res.status(200).json(JSON.parse(raw));
  }

  // ── cleaning POST ──
  if (resource === 'cleaning' && req.method === 'POST') {
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

  return res.status(400).json({ error: '올바르지 않은 resource입니다.' });
};
