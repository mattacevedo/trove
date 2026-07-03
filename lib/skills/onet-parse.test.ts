import { expect, test } from "vitest";
import {
  parseOccupationData,
  parseSkillsElements,
  parseTechnologySkills,
  parseOccupationSkillImportance,
  MIN_IMPORTANCE,
} from "./onet-parse";

// Minimal O*NET-shaped fixtures (tab-delimited, header row). Real files have more
// columns; parsers key on named columns from the header, so extra columns are fine.

const OCCUPATION_TXT = [
  "O*NET-SOC Code\tTitle\tDescription",
  "15-1252.00\tSoftware Developers\tDevelop applications.",
  "29-1141.00\tRegistered Nurses\tAssess patient health.",
  "99-9999.00\tExcluded Occupation\tNot in the v1 subset.",
].join("\n");

const SKILLS_TXT = [
  "O*NET-SOC Code\tElement ID\tElement Name\tScale ID\tData Value",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tIM\t4.12",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tLV\t3.88", // same element, LV scale — must dedupe
  "15-1252.00\t2.B.3.a\tCritical Thinking\tIM\t4.25",
].join("\n");

const TECH_TXT = [
  "O*NET-SOC Code\tExample\tCommodity Code\tHot Technology",
  "15-1252.00\tPython\t43232408\tY",
  "29-1141.00\tPython\t43232408\tY", // duplicate Example across occupations — must dedupe
  "15-1252.00\tMicrosoft Excel\t43232110\tN", // not hot — excluded
  "99-9999.00\tExcludedTool\t43232408\tY", // occupation not in allowlist — excluded
].join("\n");

const ALLOW = new Set(["15-1252.00", "29-1141.00"]);

test("parseOccupationData keeps only allowlisted occupations", () => {
  const rows = parseOccupationData(OCCUPATION_TXT, ALLOW);
  expect(rows).toEqual([
    { canonical_name: "Software Developers", type: "occupation", onet_id: "15-1252.00" },
    { canonical_name: "Registered Nurses", type: "occupation", onet_id: "29-1141.00" },
  ]);
});

test("parseSkillsElements returns distinct skill elements regardless of scale", () => {
  const rows = parseSkillsElements(SKILLS_TXT);
  expect(rows).toEqual([
    { canonical_name: "Reading Comprehension", type: "skill", onet_id: "2.A.1.a" },
    { canonical_name: "Critical Thinking", type: "skill", onet_id: "2.B.3.a" },
  ]);
});

test("parseTechnologySkills keeps hot tech in allowlisted occupations, deduped by Example", () => {
  const rows = parseTechnologySkills(TECH_TXT, ALLOW);
  expect(rows).toEqual([
    { canonical_name: "Python", type: "competency", onet_id: null },
  ]);
});

test("parsers tolerate a trailing blank line and CRLF endings", () => {
  const crlf = OCCUPATION_TXT.replace(/\n/g, "\r\n") + "\r\n";
  expect(parseOccupationData(crlf, ALLOW)).toHaveLength(2);
});

const OCC_SKILL_TXT = [
  "O*NET-SOC Code\tElement ID\tElement Name\tScale ID\tData Value\tRecommend Suppress",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tIM\t4.12\tN",
  "15-1252.00\t2.A.1.a\tReading Comprehension\tLV\t3.88\tN", // LV scale — must drop
  "15-1252.00\t2.B.3.a\tCritical Thinking\tIM\t2.50\tN",     // below MIN_IMPORTANCE — must drop
  "29-1141.00\t2.A.1.a\tReading Comprehension\tIM\t3.50\tN",
  "99-9999.00\t2.A.1.a\tReading Comprehension\tIM\t4.00\tN", // occupation not allowlisted — drop
].join("\n");

test("parseOccupationSkillImportance keeps only IM rows at/above the importance cutoff, allowlisted", () => {
  const rows = parseOccupationSkillImportance(OCC_SKILL_TXT, ALLOW);
  expect(rows).toEqual([
    { occupation_onet_id: "15-1252.00", skill_onet_id: "2.A.1.a", importance: 4.12 },
    { occupation_onet_id: "29-1141.00", skill_onet_id: "2.A.1.a", importance: 3.5 },
  ]);
  expect(MIN_IMPORTANCE).toBe(3.0);
});

test("parseOccupationSkillImportance tolerates CRLF and a trailing blank line", () => {
  const crlf = OCC_SKILL_TXT.replace(/\n/g, "\r\n") + "\r\n";
  expect(parseOccupationSkillImportance(crlf, ALLOW)).toHaveLength(2);
});
