import type { ComposeApplyPreview, ComposeApplySelection, ComposeOperation, ComposePreparation, ComposeStage } from './composeApi';

const modes = new Set(['pull', 'build', 'none']);
const statuses = new Set(['pending', 'running', 'succeeded', 'failed', 'resultUnknown', 'skipped']);
const boundedNames = (names: unknown): names is string[] => Array.isArray(names) && names.length <= 512 && names.every(name => typeof name === 'string' && name.length > 0) && new Set(names).size === names.length;
export function validApplyPreview(preview: ComposeApplyPreview): boolean {
  return Array.isArray(preview.services) && preview.services.length > 0 && preview.services.length <= 512 && new Set(preview.services.map(service => service.name)).size === preview.services.length
    && preview.services.every(service => typeof service.name === 'string' && !!service.name && (service.image === null || typeof service.image === 'string') && typeof service.build === 'boolean' && boundedNames(service.profiles)
      && (service.blockedReason === null || typeof service.blockedReason === 'string') && Array.isArray(service.preparations) && service.preparations.length <= 3 && new Set(service.preparations).size === service.preparations.length
      && service.preparations.every(mode => modes.has(mode)) && (!service.blockedReason || !service.preparations.length));
}
export function validSelections(selections: unknown): selections is ComposeApplySelection[] {
  return Array.isArray(selections) && selections.length > 0 && selections.length <= 512
    && selections.every(item => item && typeof item.service === 'string' && !!item.service && modes.has(item.preparation))
    && new Set(selections.map(item => item.service)).size === selections.length;
}
export function sameSelections(left: ComposeApplySelection[] | undefined, right: ComposeApplySelection[] | undefined): boolean {
  if (!validSelections(left) || !validSelections(right) || left.length !== right.length) return false;
  const expected = new Map(right.map(item => [item.service, item.preparation]));
  return left.every(item => expected.get(item.service) === item.preparation);
}
export function stagePlan(stages: ComposeStage[] | undefined): string {
  return JSON.stringify(stages?.map(({ kind, services }) => ({ kind, services })));
}
export function validApplyPlan(value: ComposePreparation | ComposeOperation): boolean {
  if (value.action !== 'apply') return true;
  if (!validSelections(value.selections) || !Array.isArray(value.stages) || value.stages.length !== 3 || !Array.isArray(value.warnings)) return false;
  const selected = new Set(value.selections.map(item => item.service));
  const prepared = new Map(value.selections.map(item => [item.service, item.preparation]));
  const seen = new Set<string>();
  let recreateSeen = false;
  for (const [index, stage] of value.stages.entries()) {
    if (!stage || stage.kind !== ['pull', 'build', 'recreate'][index] || !boundedNames(stage.services) || (!stage.services.length && stage.status !== 'skipped') || !statuses.has(stage.status) || !(stage.exitCode === null || Number.isInteger(stage.exitCode)) || !(stage.error === null || (stage.error && typeof stage.error.code === 'string' && typeof stage.error.message === 'string'))) return false;
    if (stage.services.some(name => !selected.has(name))) return false;
    if (stage.kind === 'recreate') {
      if (recreateSeen || stage.services.length !== selected.size) return false;
      recreateSeen = true;
    } else {
      if (recreateSeen || stage.services.some(name => prepared.get(name) !== stage.kind || seen.has(name))) return false;
      stage.services.forEach(name => seen.add(name));
    }
  }
  return recreateSeen && value.selections.every(item => item.preparation === 'none' || seen.has(item.service))
    && value.warnings.every(warning => warning && typeof warning.code === 'string' && typeof warning.image === 'string' && boundedNames(warning.services));
}
export function sameApplyPlan(value: ComposeOperation, expected: ComposePreparation | ComposeOperation): boolean {
  return value.action !== 'apply' || (validApplyPlan(value) && sameSelections(value.selections, expected.selections) && stagePlan(value.stages) === stagePlan(expected.stages));
}
