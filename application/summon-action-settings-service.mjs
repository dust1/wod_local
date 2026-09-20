import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTiming } from "../game/domain/skill.mjs";
import { ACTION_SETTINGS_VERSION, normalizeActionSettings } from "./action-settings-service.mjs";

export function defaultSummonActionSettings() {
  return { version: ACTION_SETTINGS_VERSION, defaultLayer: { actions: { initiative: [], preRound: [], mainRound: [] } } };
}

export function summonActionSettingsDto(row) {
  if (!row?.settings_json) return defaultSummonActionSettings();
  try { return normalizeSummonActionSettings(JSON.parse(row.settings_json)); }
  catch { return defaultSummonActionSettings(); }
}

export function normalizeSummonActionSettings(input, skillIds = null) {
  const normalized = normalizeActionSettings({
    version: ACTION_SETTINGS_VERSION,
    defaultLayer: input?.defaultLayer ?? input,
    floors: {},
  }, skillIds);
  return { version: ACTION_SETTINGS_VERSION, defaultLayer: { actions: normalized.defaultLayer.actions } };
}

function skillDto(repository, root, assignment) {
  const metadata = repository.getSkillDetailMetadata("summon", assignment.summon_skill_id);
  let raw = {};
  if (metadata?.json_path) {
    try { raw = JSON.parse(readFileSync(resolve(root, metadata.json_path), "utf8")); } catch { raw = {}; }
  }
  return {
    skillId: String(assignment.summon_skill_id),
    name: assignment.skill_name,
    skillType: assignment.skill_type,
    timing: parseTiming(`${raw["可以被用于"] ?? ""} ${raw["类型"] ?? ""}`).timing,
  };
}

export function summonActionConfigDto(repository, root, definitionId) {
  const definition = repository.getSummonDefinition(definitionId);
  if (!definition) throw new Error("召唤物形态不存在");
  const skills = repository.listSummonSkillAssignments()
    .filter((entry) => entry.archetype_id === definition.archetype_id && entry.active)
    .map((entry) => skillDto(repository, root, entry));
  return {
    definitionId: definition.id,
    archetypeId: definition.archetype_id,
    summonName: definition.summon_name,
    skills,
    settings: summonActionSettingsDto(repository.getSummonActionSettings(definition.id)),
  };
}

export function saveSummonActionSettings(repository, definitionId, input) {
  const definition = repository.getSummonDefinition(definitionId);
  if (!definition) throw new Error("召唤物形态不存在");
  const skillIds = repository.listSummonSkillAssignments()
    .filter((entry) => entry.archetype_id === definition.archetype_id && entry.active)
    .map((entry) => String(entry.summon_skill_id));
  const settings = normalizeSummonActionSettings(input, skillIds);
  return summonActionSettingsDto(repository.upsertSummonActionSettings(definition.id, settings));
}
