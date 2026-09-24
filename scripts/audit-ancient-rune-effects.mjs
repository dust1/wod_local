import { readFileSync } from "node:fs";
import { ANCIENT_RUNE_COMBINATIONS } from "../gamedata/overrides/ancient-rune-combinations.mjs";
import { classifyHolderRecord, parseCorrection, parseGradeCorrection } from "../game/domain/holder-effect.mjs";

const audit = { holderUnsupported: [], targetNeedsReview: [] };
for (const combination of ANCIENT_RUNE_COMBINATIONS) {
  for (const variant of Object.values(combination.variants)) {
    const effects = JSON.parse(readFileSync(new URL(`../${variant.effectPath}`, import.meta.url), "utf8"));
    effects["作用在物品持有者上的效果"].forEach((record, index) => {
      const parsed = classifyHolderRecord(record);
      if (!parsed || parsed.warnings.length > 0) {
        audit.holderUnsupported.push({ file: variant.effectPath, row: index + 1, type: record["类型"], warnings: parsed?.warnings ?? ["类型无法识别"] });
      }
    });
    (effects["作用在被此物品影响的目标上的效果"] ?? []).forEach((record, index) => {
      const gradeKey = record["类型"] === "护甲奖励" ? "护甲(r)" : record["类型"] === "伤害奖励" ? "伤害奖励(r)"
        : record["类型"] === "对此种攻击方式，攻击类型伤害的脆弱性" ? "奖励(r)" : null;
      if (gradeKey && record[gradeKey]) {
        const grades = parseGradeCorrection(record[gradeKey]);
        if (grades.every((grade) => grade.terms.length > 0 && grade.unparsed.length === 0)) return;
      }
      const recognizedType = ["属性奖励", "对技能等级的奖励", "对技能效果的奖励", "防御奖励", "攻击奖励"].includes(record["类型"]);
      const parsedCorrection = parseCorrection(record["修正"] ?? "");
      if (!recognizedType || parsedCorrection.terms.length === 0 || parsedCorrection.unparsed.length > 0) {
        audit.targetNeedsReview.push({ file: variant.effectPath, row: index + 1, type: record["类型"], correction: record["修正"] ?? null });
      }
    });
  }
}
console.log(JSON.stringify(audit, null, 2));
