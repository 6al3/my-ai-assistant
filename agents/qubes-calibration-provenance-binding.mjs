function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function digest(value, name = 'calibrationEvidenceDigest') {
  const normalized = nonEmpty(value, name);
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256 hex digest`);
  return normalized;
}

function parseJsonl(jsonl, name = 'campaign') {
  if (typeof jsonl !== 'string') throw new TypeError(`${name} must be JSONL text`);
  return jsonl.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${name} contains invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

function normalizeBinding({ topologyId, calibrationEvidenceDigest } = {}, prefix = 'binding') {
  return {
    topologyId: nonEmpty(topologyId, `${prefix}.topologyId`),
    calibrationEvidenceDigest: digest(calibrationEvidenceDigest, `${prefix}.calibrationEvidenceDigest`)
  };
}

export function bindCalibrationCampaignProvenance(jsonl, binding) {
  const expected = normalizeBinding(binding);
  const events = parseJsonl(jsonl);
  let starts = 0;
  const bound = events.map((event, index) => {
    if (event?.type !== 'campaign_start') return event;
    starts += 1;
    if (event.topologyId !== undefined && nonEmpty(event.topologyId, `event[${index}].topologyId`) !== expected.topologyId) throw new Error('campaign_start topologyId conflicts with calibrated selection');
    if (event.calibrationEvidenceDigest !== undefined && digest(event.calibrationEvidenceDigest, `event[${index}].calibrationEvidenceDigest`) !== expected.calibrationEvidenceDigest) throw new Error('campaign_start calibration evidence digest conflicts with calibrated selection');
    return { ...event, ...expected };
  });
  if (starts !== 1) throw new Error(`campaign must contain exactly one campaign_start; found ${starts}`);
  return bound.map(event => JSON.stringify(event)).join('\n');
}

export function validateCalibrationCampaignProvenance(campaigns, binding) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) throw new TypeError('campaigns must be a non-empty array');
  const expected = normalizeBinding(binding, 'expected');
  const runIds = [];
  for (const [campaignIndex, campaign] of campaigns.entries()) {
    const events = Array.isArray(campaign) ? campaign : parseJsonl(campaign, `campaign[${campaignIndex}]`);
    const starts = events.filter(event => event?.type === 'campaign_start');
    if (starts.length !== 1) throw new Error(`campaign[${campaignIndex}] must contain exactly one campaign_start; found ${starts.length}`);
    const start = starts[0];
    const topologyId = nonEmpty(start.topologyId, `campaign[${campaignIndex}].campaign_start.topologyId`);
    const calibrationEvidenceDigest = digest(start.calibrationEvidenceDigest, `campaign[${campaignIndex}].campaign_start.calibrationEvidenceDigest`);
    if (topologyId !== expected.topologyId) throw new Error(`campaign[${campaignIndex}] topologyId does not match calibrated selection`);
    if (calibrationEvidenceDigest !== expected.calibrationEvidenceDigest) throw new Error(`campaign[${campaignIndex}] calibration evidence digest does not match calibrated selection`);
    runIds.push(nonEmpty(start.runId, `campaign[${campaignIndex}].campaign_start.runId`));
  }
  return { ...expected, campaignCount: campaigns.length, runIds };
}
