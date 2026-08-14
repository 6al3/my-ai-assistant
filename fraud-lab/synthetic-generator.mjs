const merchants = ['electronics','travel','gaming','marketplace','grocery','fashion','digital-goods'];
const countries = ['ES','FR','DE','GB','US','CA','NL','IT'];
const channels = ['ecommerce','card_present','wallet','recurring'];

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function rand(min, max) { return Math.random() * (max - min) + min; }

export function generateSyntheticTransaction(id) {
  const suspicious = Math.random() < 0.18;
  const amount = Number(rand(3, suspicious ? 1800 : 450).toFixed(2));
  const velocity = suspicious ? Math.floor(rand(4, 18)) : Math.floor(rand(0, 4));
  const deviceAgeHours = suspicious ? Math.floor(rand(0, 24)) : Math.floor(rand(24, 5000));
  const riskSignals = [];
  if (velocity >= 5) riskSignals.push('high_velocity');
  if (deviceAgeHours < 6) riskSignals.push('new_device');
  if (amount > 900) riskSignals.push('high_amount');
  if (Math.random() < (suspicious ? 0.55 : 0.05)) riskSignals.push('geo_mismatch');
  if (Math.random() < (suspicious ? 0.45 : 0.03)) riskSignals.push('billing_shipping_mismatch');
  return {
    id: `tx-${id}`,
    amount,
    currency: 'EUR',
    merchantCategory: pick(merchants),
    country: pick(countries),
    channel: pick(channels),
    velocity24h: velocity,
    deviceAgeHours,
    threeDS: Math.random() < 0.7 ? 'frictionless_or_challenge' : 'not_present',
    avs: Math.random() < 0.88 ? 'match' : 'mismatch',
    cvv: Math.random() < 0.95 ? 'match' : 'mismatch',
    riskSignals,
    label: suspicious ? 'synthetic_fraud' : 'synthetic_legit'
  };
}

export function generateDataset(count = 1000) {
  return Array.from({ length: count }, (_, i) => generateSyntheticTransaction(i + 1));
}
