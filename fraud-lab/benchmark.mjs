import { generateDataset } from './synthetic-generator.mjs';
import { evaluate } from './scoring.mjs';
import { buildSyntheticGraph, findSyntheticRiskClusters } from './graph-simulator.mjs';

export function runBenchmark({ size = 5000, thresholds = [35,45,55,65] } = {}) {
  const dataset = generateDataset(size);
  const thresholdResults = thresholds.map(threshold => ({ threshold, ...evaluate(dataset, threshold) }));
  const graph = buildSyntheticGraph(dataset);
  const clusters = findSyntheticRiskClusters(graph).slice(0, 20);
  const best = [...thresholdResults].sort((a, b) => {
    const aScore = (a.recall * 0.55) + (a.precision * 0.35) + ((1 - a.falsePositiveRate) * 0.10);
    const bScore = (b.recall * 0.55) + (b.precision * 0.35) + ((1 - b.falsePositiveRate) * 0.10);
    return bScore - aScore;
  })[0];
  return {
    datasetSize: dataset.length,
    bestThreshold: best,
    thresholdResults,
    graph: { nodes: graph.nodes.length, edges: graph.edges.length, riskClusters: clusters },
    generatedAt: new Date().toISOString()
  };
}
