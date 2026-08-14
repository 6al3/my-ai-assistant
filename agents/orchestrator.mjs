import registry from './registry.json' with { type: 'json' };

const rules = [
  ['coder', /code|bug|debug|refactor|patch|برمج|كود|عدل|خطأ/i],
  ['system', /cpu|ram|service|system|box|linux|qubes|خدمة|نظام|رام/i],
  ['files', /file|folder|data|ملف|مجلد|بيانات/i],
  ['web', /web|internet|research|search|ويب|انترنت|ابحث/i],
  ['memory', /memory|remember|context|ذاكر|تذكر/i],
  ['media', /voice|audio|image|video|صوت|صورة|فيديو/i],
  ['audit', /audit|login|security|health|سجل|دخول|حالة/i]
];

export function getAgents() {
  return registry.agents;
}

export function routeTask(text = '') {
  const selected = new Set(['orchestrator']);
  const complex = text.length > 180 || /plan|project|build|طور|خطة|مشروع/i.test(text);
  if (complex) selected.add('planner');
  for (const [id, rx] of rules) if (rx.test(text)) selected.add(id);
  if (selected.size === 1) selected.add('planner');
  if (selected.has('coder') || selected.has('system')) selected.add('qa');
  return registry.agents.filter(a => selected.has(a.id));
}

export function buildExecutionPlan(text = '') {
  const agents = routeTask(text);
  return {
    task: text,
    status: 'planned',
    agents: agents.map(({ id, name, role }) => ({ id, name, role })),
    reviewRequired: agents.some(a => ['coder', 'system'].includes(a.id)),
    createdAt: new Date().toISOString()
  };
}
