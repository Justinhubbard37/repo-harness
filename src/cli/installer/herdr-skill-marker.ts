import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Prefixed } from "../../core/evidence/sha256";

/** The owner marker that the Herdr skill step writes beside SKILL.md. */
export const HERDR_SKILL_MARKER = ".repo-harness-owner.json";

/**
 * True when the directory holds only the marker and SKILL.md, both regular files, the marker names
 * repo-harness, and its hash matches SKILL.md. The entry checks run first: a read of a FIFO blocks.
 */
export function ownedSkillIsIntact(directory: string): boolean {
  try {
    const entries = readdirSync(directory).sort();
    if (entries.join(",") !== `${HERDR_SKILL_MARKER},SKILL.md` || !entries.every((name) => lstatSync(join(directory, name)).isFile())) return false;
    const marker = JSON.parse(readFileSync(join(directory, HERDR_SKILL_MARKER), "utf8"));
    return marker.owner === "repo-harness"
      && marker.sha256 === sha256Prefixed(readFileSync(join(directory, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}
