export function scoreTransaction(tx) {
  let score = 0;
  const reasons = [];
  const add = (n, reason) => { score += n; reasons.push(reason); };
  if (tx.velocity24h >= 5) add(25, 'high_velocity');
  if (tx.deviceAgeHours < 6) add(20, 'new_device');
  if (tx.amount > 900) add(20, 'high_amount');
  if (tx.riskSignals?.includes('geo_mismatch')) add(20, 'geo_mismatch');
  if (tx.riskSignals?.includes('billing_shipping_mismatch')) add(15, 'billing_shipping_mismatch');
  if (tx.avs === 'mismatch') add(10, 'avs_mismatch');
  if (tx.cvv === 'mismatch') add(15, 'cvv_mismatch');
  return { score: Math.min(score, 100), reasons };
}

export function evaluate(dataset, threshold = 50) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const tx of dataset) {
    const predictedFraud = scoreTransaction(tx).score >= threshold;
    const actualFraud = tx.label === 'synthetic_fraud';
    if (predictedFraud && actualFraud) tp++;
    else if (predictedFraud && !actualFraud) fp++;
    else if (!predictedFraud && actualFraud) fn++;
    else tn++;
  }
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const fpr = fp / Math.max(fp + tn, 1);
  const accuracy = (tp + tn) / Math.max(dataset.length, 1);
  return { tp, tn, fp, fn, precision, recall, falsePositiveRate: fpr, accuracy };
}
