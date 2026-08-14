export function buildSyntheticGraph(transactions = []) {
  const nodes = new Map();
  const edges = [];
  for (const tx of transactions) {
    const account = `acct-${(Number(tx.id?.split('-')[1]) || 0) % 75}`;
    const device = `dev-${(tx.deviceAgeHours ?? 0) % 40}`;
    const merchant = `merchant-${tx.merchantCategory || 'unknown'}`;
    for (const [id, type] of [[account,'account'],[device,'device'],[merchant,'merchant']]) {
      if (!nodes.has(id)) nodes.set(id, { id, type });
    }
    edges.push({ from: account, to: device, type: 'uses_device', tx: tx.id });
    edges.push({ from: account, to: merchant, type: 'pays_merchant', tx: tx.id, label: tx.label });
  }
  return { nodes: [...nodes.values()], edges };
}

export function findSyntheticRiskClusters(graph) {
  const counts = new Map();
  for (const edge of graph.edges || []) {
    if (edge.label !== 'synthetic_fraud') continue;
    counts.set(edge.from, (counts.get(edge.from) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([node, count]) => ({ node, syntheticFraudEdges: count }))
    .sort((a, b) => b.syntheticFraudEdges - a.syntheticFraudEdges);
}
