export const saddamAgent = {
  id: 'saddam',
  name: 'Saddam',
  role: 'Evaluation coordinator for the model arena and security lab',
  capabilities: [
    'schedule_bounded_evaluations',
    'run_same_corpus_against_multiple_models',
    'compare_results',
    'flag_critical_failures',
    'route_needs_review',
    'collect_evidence_metadata'
  ],
  limits: {
    max_cases_per_run: 5000,
    executes_host_network_changes: false,
    executes_untrusted_commands: false,
    exposes_secrets: false
  }
};

export default saddamAgent;
