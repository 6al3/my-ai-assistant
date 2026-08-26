export const MODEL_REGISTRY = {
  mini: {
    id: 'mini',
    name: 'GPT-5 mini',
    provider: 'self-hosted',
    envBaseUrl: 'AI_MINI_BASE_URL',
    envModel: 'AI_MINI_MODEL'
  },
  maxRed: {
    id: 'maxRed',
    name: 'GPT-5 MAX Red',
    provider: 'external-compatible',
    envBaseUrl: 'AI_MAX_RED_BASE_URL',
    envModel: 'AI_MAX_RED_MODEL'
  }
};

export function getModelProfile(modelId) {
  return MODEL_REGISTRY[modelId] || MODEL_REGISTRY.mini;
}
