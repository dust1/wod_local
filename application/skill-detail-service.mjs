import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

export function loadSkillDetail(repository, root, scope, skillId) {
  if (scope !== "race" && scope !== "profession") return null;
  const metadata = repository.getSkillDetailMetadata(scope, skillId);
  if (!metadata) return null;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, metadata.json_path);
  const fromRoot = relative(rootPath, filePath);
  if (fromRoot.startsWith("..") || fromRoot.includes(":")) throw new Error("技能详情路径无效");
  const detail = JSON.parse(readFileSync(filePath, "utf8"));
  return {
    metadata: {
      scope: metadata.scope,
      skillId: metadata.skill_id,
      name: metadata.skill_name,
      sourceTable: metadata.source_table,
      contentHash: metadata.content_hash,
      parsedAt: metadata.parsed_at,
    },
    detail,
  };
}
