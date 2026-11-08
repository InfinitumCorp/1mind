// The Infinitum product ontology: repo -> product, division. Unmapped repos still appear under "Unassigned".
export const DIVISIONS = [
  { id: "platform", name: "Platform & AI" },
  { id: "intel", name: "Intelligence" },
  { id: "defense", name: "Defense" },
  { id: "comms", name: "Privacy & Comms" },
  { id: "ledger", name: "Data & Ledger" },
  { id: "finance", name: "Finance" },
  { id: "web", name: "Web Properties" },
  { id: "studios", name: "Studios" },
  { id: "internal", name: "Internal" },
  { id: "unassigned", name: "Unassigned" },
];

export const PRODUCTS = {
  "1mind": { product: "1MIND", division: "platform", builtin: true },
  conjure: { product: "Conjure", division: "platform", builtin: true },
  architect: { product: ":\\ARCHITECT\\\\ /CNDCTR/", division: "platform" },
  "infinitum-nexus": { product: "NEXUS (monorepo)", division: "platform" },
  RULES: { product: "RULES", division: "platform" },
  "scalvs-ai-metatron-bot": { product: "SCALVS.ai / METATRON¹⁰⁰", division: "platform" },
  eidetic: { product: "ei·det·ic", division: "intel" },
  zerkalo: { product: "Zerkalo", division: "intel" },
  "argus-military-reference": { product: ">_ARGUS Military", division: "defense" },
  "argus-odin-reference": { product: ">_ARGUS / ODIN° Observe", division: "defense" },
  odin: { product: "ODIN°", division: "defense" },
  "odin-daemon": { product: "ODIN DAEMON", division: "defense" },
  eon: { product: "E(O)N", division: "defense" },
  "veil-vpn": { product: "VEIL</>", division: "comms" },
  fabric: { product: "FABRIC", division: "comms" },
  aether: { product: "ÆTHER", division: "comms" },
  "cumulus-mail": { product: "Cumulus://Mail", division: "comms" },
  "cumulus-exchange": { product: "Cumulus Data Exchange", division: "ledger" },
  hrvst: { product: "[HRVST]", division: "ledger" },
  "firmament-launch": { product: "Firmament Network", division: "ledger" },
  "infinitum-revenue": { product: "Revenue & Billing", division: "finance" },
  "infinitum-corporation-site": { product: "infinitum.corp site", division: "web" },
  "infinitum-defense-site": { product: "Infinitum Defense site", division: "web" },
  "infinitum-academy": { product: "Infinitum Academy", division: "web" },
  "williamaaronturner-redesign": { product: "WAT redesign", division: "web" },
  "capital-chronicles": { product: "Capital Chronicles", division: "web" },
  "aleph-pr": { product: "Aleph PR", division: "studios" },
  "ukraine-files-flyers": { product: "Ukraine Files", division: "studios" },
  InfinitumCorp: { product: "GitHub profile", division: "internal" },
  "cos-workspace-backup": { product: "COS workspace backup", division: "internal" },
};

// Repos 1MIND does not control: never listed, pulled, built or scanned.
// Removing a name here brings it back on the next GitHub sync.
export const EXCLUDED = new Set(["william-aaron-turner", "vyral-london", "prpgnd"]);

export function productFor(repo) {
  return PRODUCTS[repo] ?? { product: repo, division: "unassigned" };
}
