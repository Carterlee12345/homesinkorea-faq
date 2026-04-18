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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const userToken = req.headers['authorization']?.replace('Bearer ', '');
  if (!await verifyToken(userToken)) return res.status(401).json({ error: '인증이 필요합니다.' });

  try {
    const haToken = await getHAToken();
    const today = new Date().toISOString().split('T')[0];

    // Fetch current + future reservations
    const [activeData, listingsData] = await Promise.all([
      haFetch(`/reservations?status=confirmed&arrivalStartDate=${today}&limit=100&includeResources=true`, haToken),
      haFetch(`/listings?limit=100`, haToken)
    ]);

    // Also fetch currently staying guests (arrived before today, departing after today)
    const stayingData = await haFetch(
      `/reservations?status=confirmed&arrivalEndDate=${today}&departureDateStart=${today}&limit=100`, haToken
    );

    const listingMap = {};
    (listingsData.result || []).forEach(l => {
      listingMap[l.id] = {
        name: l.externalName || l.name || '',
        bedrooms: l.bedroomsNumber || 0,
        bathrooms: l.bathroomsNumber || 0,
        address: l.address || ''
      };
    });

    const allReservations = [
      ...(stayingData.result || []),
      ...(activeData.result || [])
    ];

    // Deduplicate by reservationId
    const seen = new Set();
    const reservations = allReservations.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }).map(r => {
      const listing = listingMap[r.listingId] || {};
      const arr = r.arrivalDate?.split('T')[0] || r.arrivalDate || '';
      const dep = r.departureDate?.split('T')[0] || r.departureDate || '';
      const isStaying = arr <= today && dep > today;
      return {
        id: r.id,
        listingId: r.listingId,
        listingName: listing.name,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        address: listing.address,
        arrivalDate: arr,
        departureDate: dep,
        guestName: r.guestName || '',
        isStaying,
        displayDate: isStaying ? dep : arr
      };
    });

    return res.status(200).json({ reservations });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
